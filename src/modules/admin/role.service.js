import { literal, Op } from 'sequelize';
import { AuthSession, Permission, Role, User } from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { recordAudit } from '../audits/audit.service.js';
import { actorOwner } from './staff.service.js';

const roleInclude = [{ model: Permission, as: 'permissions', through: { attributes: ['allow'] } }];

function roleDto(role) {
  return { id: role.id, key: role.key, name: role.name, protected: role.protected, system: role.system, active: role.active, version: Number(role.version), permissions: (role.permissions || []).map((permission) => ({ id: permission.id, key: permission.key, module: permission.module, description: permission.description })).sort((left, right) => left.key.localeCompare(right.key)), createdAt: role.createdAt, updatedAt: role.updatedAt };
}

export async function listRoles() {
  const rows = await Role.findAll({ include: roleInclude, order: [['protected', 'DESC'], ['name', 'ASC']] });
  return rows.map(roleDto);
}

export async function listPermissions() {
  const rows = await Permission.findAll({ order: [['module', 'ASC'], ['key', 'ASC']] });
  return rows.map((permission) => ({ id: permission.id, key: permission.key, module: permission.module, description: permission.description }));
}

async function validatePermissions(ids, transaction) {
  const unique = [...new Set(ids)];
  const permissions = await Permission.findAll({ where: { id: { [Op.in]: unique } }, order: [['id', 'ASC']], transaction });
  if (permissions.length !== unique.length) throw AppError.unprocessable('INVALID_PERMISSION', 'One or more permissions do not exist.');
  return permissions;
}

export async function createRole(payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const permissions = await validatePermissions(payload.permissionIds, transaction);
    const role = await Role.create({ id: newId(), key: payload.key, name: payload.name, protected: false, system: false, active: true, version: 1 }, { transaction });
    await role.setPermissions(permissions, { transaction });
    await recordAudit({ actorId, action: 'role.create', resourceType: 'role', resourceId: role.id, after: { key: role.key, name: role.name, permissionIds: permissions.map((permission) => permission.id) }, request, transaction });
    return roleDto(await Role.findByPk(role.id, { include: roleInclude, transaction }));
  });
}

export async function updateRole(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const role = await Role.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!role) throw AppError.notFound('Role not found.');
    if (role.protected) throw AppError.conflict('PROTECTED_ROLE', 'Protected roles cannot be edited.');
    if (Number(payload.version) !== Number(role.version)) throw AppError.conflict('VERSION_CONFLICT', 'This role changed. Refresh and review the latest version.');
    const permissions = await validatePermissions(payload.permissionIds, transaction);
    const before = roleDto(await Role.findByPk(id, { include: roleInclude, transaction }));
    role.name = payload.name;
    role.active = payload.active;
    role.version += 1;
    await role.save({ transaction });
    await role.setPermissions(permissions, { transaction });
    const users = await role.getUsers({ transaction, lock: transaction.LOCK.UPDATE });
    if (users.length) {
      await User.update(
        { roleVersion: literal('roleVersion + 1'), version: literal('version + 1') },
        {
          where: { id: { [Op.in]: users.map((user) => user.id) } },
          transaction,
        },
      );
      await AuthSession.update({ revokedAt: new Date(), revokeReason: 'role_permissions_changed' }, { where: { userId: { [Op.in]: users.map((user) => user.id) }, revokedAt: null }, transaction });
    }
    const after = roleDto(await Role.findByPk(id, { include: roleInclude, transaction }));
    await recordAudit({ actorId, action: 'role.update', resourceType: 'role', resourceId: role.id, before, after, metadata: { affectedUsers: users.length, reason: payload.reason }, request, transaction });
    return after;
  });
}

export async function archiveRole(id, version, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const role = await Role.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!role) throw AppError.notFound('Role not found.');
    if (role.protected || role.system) throw AppError.conflict('PROTECTED_ROLE', 'System roles cannot be archived.');
    if (Number(version) !== Number(role.version)) throw AppError.conflict('VERSION_CONFLICT', 'This role changed. Refresh and review the latest version.');
    const users = await role.getUsers({ transaction, lock: transaction.LOCK.UPDATE });
    if (users.length) throw AppError.conflict('ROLE_IN_USE', 'Remove this role from all staff members before archiving it.');
    role.active = false;
    role.version += 1;
    await role.save({ transaction });
    await recordAudit({ actorId, action: 'role.archive', resourceType: 'role', resourceId: role.id, after: { active: false }, request, transaction });
    return roleDto(await Role.findByPk(id, { include: roleInclude, transaction }));
  });
}

export async function ownerInvariantSummary(actorId) {
  if (!await actorOwner(actorId, null)) throw AppError.forbidden();
  const owner = await Role.findOne({ where: { key: 'owner' } });
  const users = owner ? await owner.getUsers({ where: { status: 'active' } }) : [];
  return { activeOwners: users.length, ownerIds: users.map((user) => user.id) };
}

export { roleDto };
