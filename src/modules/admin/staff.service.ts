import { Op } from "sequelize";
import {
  AuthSession,
  MfaMethod,
  Permission,
  Role,
  User,
  UserPermissionOverride,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId, randomToken } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import {
  effectivePermissionKeys,
  userAuthInclude,
} from "../auth/authorization.js";
import { queueNotification } from "../events/outbox.service.js";

function staffDto(user: RuntimeValue) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    status: user.status,
    locale: user.locale,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    emailVerified: Boolean(user.emailVerifiedAt),
    mustChangePassword: Boolean(user.mustChangePassword),
    mfaEnabled: Boolean(user.mfaMethods?.length),
    roles: (user.roles || []).map((role: RuntimeValue) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      protected: role.protected,
    })),
    permissionOverrides: (user.permissionOverrides || []).map(
      (override: RuntimeValue) => ({
        id: override.id,
        permissionId: override.permissionId,
        key: override.permission?.key,
        allow: override.allow,
        reason: override.reason,
      }),
    ),
    effectivePermissions: effectivePermissionKeys(user),
    lastLoginAt: user.lastLoginAt,
    roleVersion: Number(user.roleVersion),
    version: Number(user.version),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function loadStaff(id: RuntimeValue, transaction: RuntimeValue = null) {
  return User.findByPk(id, {
    paranoid: false,
    include: userAuthInclude,
    transaction,
  });
}

async function actorOwner(actorId: RuntimeValue, transaction: RuntimeValue) {
  const actor: RuntimeValue = await User.findByPk(actorId, {
    include: [
      {
        model: Role,
        as: "roles",
        where: { key: "owner", active: true },
        required: false,
        through: { attributes: [] },
      },
    ],
    transaction,
  });
  return Boolean(
    actor?.roles?.some((role: RuntimeValue) => role.key === "owner"),
  );
}

/**
 * Non-owners may only grant or manage access that they themselves hold, so a
 * delegated roles.manage/staff.manage holder cannot escalate (directly or by
 * taking over a more privileged account through a password reset).
 */
async function assertWithinActorPermissions(
  actorId: RuntimeValue,
  permissionKeys: RuntimeValue,
  transaction: RuntimeValue,
) {
  if (!permissionKeys.length || (await actorOwner(actorId, transaction)))
    return;
  const actor: RuntimeValue = await User.findByPk(actorId, {
    include: userAuthInclude,
    transaction,
  });
  const held = new Set(actor ? effectivePermissionKeys(actor) : []);
  if (permissionKeys.some((key: RuntimeValue) => !held.has(key)))
    throw AppError.forbidden(
      "You cannot grant or manage access beyond your own permissions.",
    );
}

async function grantedPermissionKeys(
  roleIds: RuntimeValue,
  overrides: RuntimeValue,
  transaction: RuntimeValue,
) {
  const roles: RuntimeValue = await Role.findAll({
    where: { id: { [Op.in]: roleIds } },
    include: [
      {
        model: Permission,
        as: "permissions",
        through: { attributes: [], where: { allow: true } },
      },
    ],
    transaction,
  });
  const overridePermissions: RuntimeValue = overrides.length
    ? await Permission.findAll({
        where: {
          id: {
            [Op.in]: overrides.map(
              (override: RuntimeValue) => override.permissionId,
            ),
          },
        },
        transaction,
      })
    : [];
  const keyById = new Map(
    overridePermissions.map((permission: RuntimeValue) => [
      permission.id,
      permission.key,
    ]),
  );
  return effectivePermissionKeys({
    roles,
    permissionOverrides: overrides.map((override: RuntimeValue) => ({
      allow: override.allow,
      permission: { key: keyById.get(override.permissionId) },
    })),
  });
}

async function assertActorManagesTarget(
  actorId: RuntimeValue,
  targetId: RuntimeValue,
  transaction: RuntimeValue,
) {
  const target: RuntimeValue = await loadStaff(targetId, transaction);
  if (target)
    await assertWithinActorPermissions(
      actorId,
      effectivePermissionKeys(target),
      transaction,
    );
}

async function lockOwnerInvariant(transaction: RuntimeValue) {
  const ownerRole: RuntimeValue = await Role.findOne({
    where: { key: "owner" },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!ownerRole) throw new Error("Owner role is not seeded.");
  const owners: RuntimeValue = await ownerRole.getUsers({
    where: { status: "active" },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return { ownerRole, owners };
}

async function assertCanChangeOwner({
  target,
  nextRoleIds = null,
  nextStatus = null,
  actorId,
  transaction,
}: RuntimeValue) {
  const { ownerRole, owners }: RuntimeValue =
    await lockOwnerInvariant(transaction);
  const currentlyOwner: RuntimeValue = await target.hasRole(ownerRole, {
    transaction,
  });
  const willBeOwner: RuntimeValue = nextRoleIds
    ? nextRoleIds.includes(ownerRole.id)
    : currentlyOwner;
  const willBeActive = nextStatus
    ? nextStatus === "active"
    : target.status === "active";
  if (
    (currentlyOwner || willBeOwner) &&
    !(await actorOwner(actorId, transaction))
  )
    throw AppError.forbidden(
      "Only an Owner can grant, remove, disable, or edit an Owner account.",
    );
  if (
    currentlyOwner &&
    target.status === "active" &&
    (!willBeOwner || !willBeActive) &&
    owners.length <= 1
  )
    throw AppError.conflict(
      "LAST_OWNER_REQUIRED",
      "At least one active Owner account must remain.",
    );
  return { ownerRole, currentlyOwner, willBeOwner };
}

async function validateRoleIds(
  roleIds: RuntimeValue,
  transaction: RuntimeValue,
) {
  const unique: RuntimeValue = [...new Set(roleIds)];
  const roles: RuntimeValue = await Role.findAll({
    where: { id: { [Op.in]: unique }, active: true },
    order: [["id", "ASC"]],
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  if (!roles.length || roles.length !== unique.length)
    throw AppError.unprocessable(
      "INVALID_STAFF_ROLE",
      "Choose one or more active staff roles.",
    );
  if (roles.some((role: RuntimeValue) => role.key === "customer"))
    throw AppError.unprocessable(
      "INVALID_STAFF_ROLE",
      "The Customer role cannot be assigned as staff access.",
    );
  return roles;
}

export async function listStaff(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.search)
    where[Op.or] = [
      { name: { [Op.like]: likeContains(query.search, 100) } },
      { phone: { [Op.like]: likeContains(query.search, 30) } },
      { email: { [Op.like]: likeContains(query.search, 100) } },
    ];
  const roleWhere: RuntimeValue = {
    key: { [Op.ne]: "customer" },
    ...(query.role ? { key: query.role } : {}),
  };
  const result: RuntimeValue = await User.findAndCountAll({
    where,
    include: [
      {
        model: Role,
        as: "roles",
        where: roleWhere,
        required: true,
        through: { attributes: [] },
        include: [
          { model: Permission, as: "permissions", through: { attributes: [] } },
        ],
      },
      {
        model: UserPermissionOverride,
        as: "permissionOverrides",
        required: false,
        include: [{ model: Permission, as: "permission" }],
      },
      {
        model: MfaMethod,
        as: "mfaMethods",
        required: false,
        where: { confirmedAt: { [Op.ne]: null }, disabledAt: null },
        attributes: ["id", "type", "confirmedAt"],
      },
    ],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map(staffDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getStaff(id: RuntimeValue) {
  const user: RuntimeValue = await loadStaff(id);
  if (
    !user ||
    !user.roles?.some((role: RuntimeValue) => role.key !== "customer")
  )
    throw AppError.notFound("Staff member not found.");
  return staffDto(user);
}

export async function createStaff(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const phone: RuntimeValue = normalizePhone(payload.phone);
  const email: RuntimeValue = normalizeEmail(payload.email);
  if (payload.phone && !phone)
    throw AppError.unprocessable(
      "INVALID_PHONE",
      "Enter a valid Bangladeshi phone number.",
    );
  if (!phone && !email)
    throw AppError.unprocessable(
      "IDENTIFIER_REQUIRED",
      "A staff account requires a phone number or email.",
    );
  const temporaryPassword = `Ee!${randomToken(18)}`;
  const data: RuntimeValue = await sequelize.transaction(
    async (transaction: RuntimeValue) => {
      const roles: RuntimeValue = await validateRoleIds(
        payload.roleIds,
        transaction,
      );
      const ownerRole: RuntimeValue = roles.find(
        (role: RuntimeValue) => role.key === "owner",
      );
      if (ownerRole && !(await actorOwner(actorId, transaction)))
        throw AppError.forbidden(
          "Only an Owner can create another Owner account.",
        );
      await assertWithinActorPermissions(
        actorId,
        await grantedPermissionKeys(
          roles.map((role: RuntimeValue) => role.id),
          [],
          transaction,
        ),
        transaction,
      );
      const duplicate: RuntimeValue = await User.findOne({
        where: {
          [Op.or]: [phone && { phone }, email && { email }].filter(Boolean),
        },
        paranoid: false,
        transaction,
      });
      if (duplicate)
        throw AppError.conflict(
          "IDENTIFIER_IN_USE",
          "That phone number or email is already assigned to an account.",
        );
      const user: RuntimeValue = await User.create(
        {
          id: newId(),
          name: payload.name,
          phone,
          email,
          passwordHash: await hashPassword(temporaryPassword),
          status: "active",
          locale: payload.locale,
          mustChangePassword: true,
          version: 1,
          roleVersion: 1,
        },
        { transaction },
      );
      await user.setRoles(roles, { transaction });
      await recordAudit({
        actorId,
        action: "staff.create",
        resourceType: "user",
        resourceId: user.id,
        after: {
          name: user.name,
          phone: user.phone,
          email: user.email,
          roleIds: roles.map((role: RuntimeValue) => role.id),
          mustChangePassword: true,
        },
        request,
        transaction,
      });
      if (email || phone)
        await queueNotification({
          event: "staff.invited",
          channel: email ? "email" : "sms",
          locale: user.locale,
          recipient: email || phone,
          payload: {
            message:
              "Your Elite Emporium staff account is ready. Contact the account owner for your one-time password.",
            name: user.name,
          },
          transaction,
        });
      return staffDto(await loadStaff(user.id, transaction));
    },
  );
  return { staff: data, temporaryPassword };
}

export async function updateStaffProfile(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await User.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw AppError.notFound("Staff member not found.");
    if (Number(payload.version) !== Number(user.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This staff account changed. Refresh and review the latest version.",
      );
    await assertCanChangeOwner({
      target: user,
      nextStatus: payload.status,
      actorId,
      transaction,
    });
    await assertActorManagesTarget(actorId, user.id, transaction);
    const phone: RuntimeValue =
      payload.phone == null ? null : normalizePhone(payload.phone);
    const email: RuntimeValue =
      payload.email == null ? null : normalizeEmail(payload.email);
    if (payload.phone && !phone)
      throw AppError.unprocessable(
        "INVALID_PHONE",
        "Enter a valid Bangladeshi phone number.",
      );
    if (!phone && !email)
      throw AppError.unprocessable(
        "IDENTIFIER_REQUIRED",
        "A staff account requires a phone number or email.",
      );
    const duplicate: RuntimeValue = await User.findOne({
      where: {
        id: { [Op.ne]: user.id },
        [Op.or]: [phone && { phone }, email && { email }].filter(Boolean),
      },
      paranoid: false,
      transaction,
    });
    if (duplicate)
      throw AppError.conflict(
        "IDENTIFIER_IN_USE",
        "That phone number or email is already assigned to an account.",
      );
    const before: RuntimeValue = {
      name: user.name,
      phone: user.phone,
      email: user.email,
      locale: user.locale,
      status: user.status,
      version: user.version,
    };
    if (phone !== user.phone) user.phoneVerifiedAt = null;
    if (email !== user.email) user.emailVerifiedAt = null;
    user.name = payload.name;
    user.phone = phone;
    user.email = email;
    user.locale = payload.locale;
    user.status = payload.status;
    user.version += 1;
    await user.save({ transaction });
    if (payload.status === "disabled")
      await AuthSession.update(
        { revokedAt: new Date(), revokeReason: "account_disabled" },
        { where: { userId: user.id, revokedAt: null }, transaction },
      );
    await recordAudit({
      actorId,
      action: "staff.profile_update",
      resourceType: "user",
      resourceId: user.id,
      before,
      after: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        locale: user.locale,
        status: user.status,
        version: user.version,
      },
      request,
      transaction,
    });
    return staffDto(await loadStaff(user.id, transaction));
  });
}

export async function updateStaffAccess(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await User.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw AppError.notFound("Staff member not found.");
    if (Number(payload.version) !== Number(user.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This staff account changed. Refresh and review the latest version.",
      );
    const roles: RuntimeValue = await validateRoleIds(
      payload.roleIds,
      transaction,
    );
    await assertCanChangeOwner({
      target: user,
      nextRoleIds: roles.map((role: RuntimeValue) => role.id),
      actorId,
      transaction,
    });
    await assertActorManagesTarget(actorId, user.id, transaction);
    const permissionIds: RuntimeValue = [
      ...new Set(
        payload.overrides.map(
          (override: RuntimeValue) => override.permissionId,
        ),
      ),
    ];
    if (permissionIds.length !== payload.overrides.length)
      throw AppError.unprocessable(
        "DUPLICATE_PERMISSION_OVERRIDE",
        "Each permission can have only one explicit override.",
      );
    if (
      permissionIds.length &&
      (await Permission.count({
        where: { id: { [Op.in]: permissionIds } },
        transaction,
      })) !== permissionIds.length
    )
      throw AppError.unprocessable(
        "INVALID_PERMISSION",
        "One or more permissions do not exist.",
      );
    await assertWithinActorPermissions(
      actorId,
      await grantedPermissionKeys(
        roles.map((role: RuntimeValue) => role.id),
        payload.overrides,
        transaction,
      ),
      transaction,
    );
    const before: RuntimeValue = staffDto(
      await loadStaff(user.id, transaction),
    );
    await user.setRoles(roles, { transaction });
    await UserPermissionOverride.destroy({
      where: { userId: user.id },
      transaction,
    });
    if (payload.overrides.length)
      await UserPermissionOverride.bulkCreate(
        payload.overrides.map((override: RuntimeValue) => ({
          id: newId(),
          userId: user.id,
          permissionId: override.permissionId,
          allow: override.allow,
          reason: override.reason,
          actorId,
        })),
        { transaction },
      );
    user.roleVersion += 1;
    user.version += 1;
    await user.save({ transaction });
    await AuthSession.update(
      { revokedAt: new Date(), revokeReason: "privileges_changed" },
      { where: { userId: user.id, revokedAt: null }, transaction },
    );
    const after: RuntimeValue = staffDto(await loadStaff(user.id, transaction));
    await recordAudit({
      actorId,
      action: "staff.access_update",
      resourceType: "user",
      resourceId: user.id,
      before,
      after,
      metadata: { reason: payload.reason },
      request,
      transaction,
    });
    return after;
  });
}

export async function resetStaffPassword(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const temporaryPassword = `Ee!${randomToken(18)}`;
  await sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await User.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw AppError.notFound("Staff member not found.");
    await assertCanChangeOwner({ target: user, actorId, transaction });
    await assertActorManagesTarget(actorId, user.id, transaction);
    user.passwordHash = await hashPassword(temporaryPassword);
    user.mustChangePassword = true;
    user.version += 1;
    await user.save({ transaction });
    await AuthSession.update(
      { revokedAt: new Date(), revokeReason: "admin_password_reset" },
      { where: { userId: user.id, revokedAt: null }, transaction },
    );
    await recordAudit({
      actorId,
      action: "staff.password_reset",
      resourceType: "user",
      resourceId: user.id,
      after: { mustChangePassword: true, sessionsRevoked: true },
      request,
      transaction,
    });
  });
  return { temporaryPassword, mustChangePassword: true };
}

async function assertOwnerSessionsAccess(
  targetId: RuntimeValue,
  actorId: RuntimeValue,
  transaction: RuntimeValue,
) {
  const ownerRole: RuntimeValue = await Role.findOne({
    where: { key: "owner" },
    transaction,
  });
  const target: RuntimeValue = await User.findByPk(targetId, { transaction });
  if (!target) throw AppError.notFound("Staff member not found.");
  if (
    ownerRole &&
    (await target.hasRole(ownerRole, { transaction })) &&
    !(await actorOwner(actorId, transaction))
  )
    throw AppError.forbidden(
      "Only an Owner can inspect or revoke an Owner's sessions.",
    );
}

export async function listStaffSessions(
  id: RuntimeValue,
  actorId: RuntimeValue,
) {
  await assertOwnerSessionsAccess(id, actorId, null);
  const sessions: RuntimeValue = await AuthSession.findAll({
    where: { userId: id },
    order: [["lastUsedAt", "DESC"]],
  });
  return sessions.map((session: RuntimeValue) => ({
    id: session.id,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    revokedAt: session.revokedAt,
    revokeReason: session.revokeReason,
  }));
}

export async function revokeStaffSession(
  staffId: RuntimeValue,
  sessionId: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    await assertOwnerSessionsAccess(staffId, actorId, transaction);
    const session: RuntimeValue = await AuthSession.findOne({
      where: { id: sessionId, userId: staffId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!session) throw AppError.notFound("Session not found.");
    if (!session.revokedAt) {
      session.revokedAt = new Date();
      session.revokeReason = "revoked_by_admin";
      await session.save({ transaction });
    }
    await recordAudit({
      actorId,
      action: "staff.session_revoke",
      resourceType: "auth_session",
      resourceId: session.id,
      metadata: { staffId },
      request,
      transaction,
    });
  });
}

export { actorOwner, assertWithinActorPermissions };
