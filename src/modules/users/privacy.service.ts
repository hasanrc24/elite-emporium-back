import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { Op } from "sequelize";
import {
  AuthChallenge,
  AuthSession,
  CouponUser,
  CustomerNote,
  ExportJob,
  MediaAsset,
  MfaMethod,
  MfaRecoveryCode,
  Order,
  PasswordResetToken,
  PrivacyRequest,
  ReturnRequest,
  User,
  UserAddress,
  VerificationToken,
  Wishlist,
  WishlistItem,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { dateRangeWhere } from "../../lib/date-range.js";
import { recordAudit } from "../audits/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { signPrivateMedia } from "../media/media.storage.js";

const requestInclude: RuntimeValue = [
  {
    model: User,
    as: "user",
    attributes: ["id", "name", "phone", "email", "status", "deletedAt"],
    paranoid: false,
  },
  {
    model: User,
    as: "reviewer",
    attributes: ["id", "name"],
    required: false,
    paranoid: false,
  },
  {
    model: ExportJob,
    as: "exportJob",
    required: false,
    include: [{ model: MediaAsset, as: "file", required: false }],
  },
];

function exportDownload(asset: RuntimeValue) {
  if (!asset || asset.status !== "ready") return null;
  const expires =
    Math.floor(Date.now() / 1000) +
    Math.min(env.MEDIA_PRIVATE_URL_TTL_SECONDS, 900);
  return {
    url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expires}&signature=${encodeURIComponent(signPrivateMedia(asset.id, expires))}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

function privacyRequestDto(
  row: RuntimeValue,
  { admin = false }: RuntimeValue = {},
) {
  const job = row.exportJob;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    reason: row.reason || null,
    version: Number(row.version),
    requestedAt: row.requestedAt,
    reviewedAt: row.reviewedAt,
    completedAt: row.completedAt,
    export: job
      ? {
          id: job.id,
          status: job.status,
          expiresAt: job.expiresAt,
          errorCode: job.errorCode,
          download: job.status === "ready" ? exportDownload(job.file) : null,
        }
      : null,
    ...(admin
      ? {
          customer: row.user
            ? {
                id: row.user.id,
                name: row.user.name,
                phone: row.user.phone,
                email: row.user.email,
                status: row.user.status,
                deletedAt: row.user.deletedAt,
              }
            : null,
          reviewer: row.reviewer
            ? { id: row.reviewer.id, name: row.reviewer.name }
            : null,
          metadata: row.metadata || null,
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function hydrateRequest(
  id: RuntimeValue,
  transaction: RuntimeValue = null,
) {
  return PrivacyRequest.findByPk(id, { include: requestInclude, transaction });
}

export async function createPrivacyRequest(
  userId: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user || user.deletedAt) throw AppError.notFound("Account not found.");
    if (payload.type === "deletion") {
      if (payload.confirmation !== "DELETE MY ACCOUNT")
        throw AppError.unprocessable(
          "DELETION_CONFIRMATION_REQUIRED",
          "Enter DELETE MY ACCOUNT to confirm this request.",
        );
      if (
        !payload.currentPassword ||
        !(await argon2.verify(user.passwordHash, payload.currentPassword))
      )
        throw AppError.unprocessable(
          "REAUTHENTICATION_REQUIRED",
          "Enter your current password to request account deletion.",
          { currentPassword: ["Your current password is incorrect."] },
        );
    }
    const activeKey = `${userId}:${payload.type}`;
    const existing: RuntimeValue = await PrivacyRequest.findOne({
      where: { activeKey },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing)
      throw AppError.conflict(
        "PRIVACY_REQUEST_OPEN",
        `You already have an open ${payload.type} request.`,
      );
    const row: RuntimeValue = await PrivacyRequest.create(
      {
        id: newId(),
        userId,
        type: payload.type,
        status: "requested",
        activeKey,
        requestedAt: new Date(),
        reason: payload.note || null,
        metadata: { source: "customer" },
        version: 1,
      },
      { transaction },
    );
    await addDomainEvent({
      topic: `privacy.${payload.type}.requested`,
      aggregateType: "privacy_request",
      aggregateId: row.id,
      payload: { privacyRequestId: row.id, userId, type: row.type },
      transaction,
    });
    await recordAudit({
      actorId: userId,
      action: `privacy.${payload.type}_request`,
      resourceType: "privacy_request",
      resourceId: row.id,
      after: { type: row.type, status: row.status },
      request,
      transaction,
    });
    return privacyRequestDto(await hydrateRequest(row.id, transaction));
  });
}

export async function listOwnPrivacyRequests(userId: RuntimeValue) {
  const rows: RuntimeValue = await PrivacyRequest.findAll({
    where: { userId },
    include: requestInclude.slice(2),
    order: [["createdAt", "DESC"]],
  });
  return rows.map((row: RuntimeValue) => privacyRequestDto(row));
}

export async function listAdminPrivacyRequests(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;
  Object.assign(where, dateRangeWhere(query));
  const customerWhere = query.search
    ? {
        [Op.or]: [
          { name: { [Op.like]: likeContains(query.search, 100) } },
          { phone: { [Op.like]: likeContains(query.search, 30) } },
          { email: { [Op.like]: likeContains(query.search, 100) } },
        ],
      }
    : undefined;
  const include: RuntimeValue = requestInclude.map((entry: RuntimeValue) =>
    entry.as === "user"
      ? {
          ...entry,
          ...(customerWhere ? { where: customerWhere, required: true } : {}),
        }
      : entry,
  );
  const result: RuntimeValue = await PrivacyRequest.findAndCountAll({
    where,
    include,
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "ASC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) =>
      privacyRequestDto(row, { admin: true }),
    ),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getAdminPrivacyRequest(id: RuntimeValue) {
  const row: RuntimeValue = await hydrateRequest(id);
  if (!row) throw AppError.notFound("Privacy request not found.");
  return privacyRequestDto(row, { admin: true });
}

const transitions: RuntimeValue = {
  requested: ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved: ["completed"],
  rejected: [],
  completed: [],
};

async function ensureDeletionCanComplete(
  userId: RuntimeValue,
  transaction: RuntimeValue,
) {
  const [openOrders, openReturns]: RuntimeValue = await Promise.all([
    Order.count({
      where: {
        userId,
        orderStatus: { [Op.notIn]: ["completed", "cancelled", "failed"] },
      },
      transaction,
    }),
    ReturnRequest.count({
      where: {
        userId,
        status: { [Op.notIn]: ["rejected", "completed", "cancelled"] },
      },
      transaction,
    }),
  ]);
  if (openOrders || openReturns)
    throw AppError.conflict(
      "CUSTOMER_OPERATIONS_OPEN",
      "Resolve all active orders and return requests before completing account deletion.",
    );
}

async function anonymizeCustomer(
  user: RuntimeValue,
  actorId: RuntimeValue,
  transaction: RuntimeValue,
) {
  await ensureDeletionCanComplete(user.id, transaction);
  const roles: RuntimeValue = await user.getRoles({ transaction });
  if (roles.some((role: RuntimeValue) => role.key !== "customer"))
    throw AppError.conflict(
      "STAFF_ACCOUNT_DELETION_BLOCKED",
      "Remove staff access through staff management before anonymizing this account.",
    );
  const methods: RuntimeValue = await MfaMethod.findAll({
    where: { userId: user.id },
    attributes: ["id"],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const methodIds: RuntimeValue = methods.map(
    (method: RuntimeValue) => method.id,
  );
  if (methodIds.length)
    await MfaRecoveryCode.destroy({
      where: { methodId: { [Op.in]: methodIds } },
      transaction,
    });
  await Promise.all([
    AuthSession.update(
      { revokedAt: new Date(), revokeReason: "privacy_deletion" },
      { where: { userId: user.id, revokedAt: null }, transaction },
    ),
    AuthChallenge.destroy({ where: { userId: user.id }, transaction }),
    PasswordResetToken.destroy({ where: { userId: user.id }, transaction }),
    VerificationToken.destroy({ where: { userId: user.id }, transaction }),
    MfaMethod.destroy({ where: { userId: user.id }, transaction }),
    UserAddress.destroy({
      where: { userId: user.id },
      force: true,
      transaction,
    }),
    CouponUser.destroy({ where: { userId: user.id }, transaction }),
    MediaAsset.update(
      { status: "archived", altText: null },
      { where: { uploaderId: user.id }, transaction },
    ),
    CustomerNote.update(
      { message: "[Redacted after approved customer privacy deletion.]" },
      { where: { userId: user.id }, transaction },
    ),
  ]);
  const wishlists: RuntimeValue = await Wishlist.findAll({
    where: { userId: user.id },
    attributes: ["id"],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (wishlists.length) {
    const wishlistIds: RuntimeValue = wishlists.map(
      (wishlist: RuntimeValue) => wishlist.id,
    );
    await WishlistItem.destroy({
      where: { wishlistId: { [Op.in]: wishlistIds } },
      transaction,
    });
    await Wishlist.destroy({
      where: { id: { [Op.in]: wishlistIds } },
      transaction,
    });
  }
  user.name = "Deleted customer";
  user.phone = null;
  user.email = null;
  user.phoneVerifiedAt = null;
  user.emailVerifiedAt = null;
  user.passwordHash = await hashPassword(randomBytes(48).toString("base64url"));
  user.status = "disabled";
  user.roleVersion += 1;
  user.version += 1;
  await user.save({ transaction });
  await user.destroy({ transaction });
  await recordAudit({
    actorId,
    action: "privacy.customer_anonymized",
    resourceType: "user",
    resourceId: user.id,
    after: {
      status: "disabled",
      deletedAt: user.deletedAt,
      statutoryOrderRecordsRetained: true,
    },
    transaction,
  });
}

export async function transitionPrivacyRequest(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await PrivacyRequest.findByPk(id, {
      include: [{ model: ExportJob, as: "exportJob", required: false }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Privacy request not found.");
    if (Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This privacy request changed. Refresh and review the latest version.",
      );
    if (!transitions[row.status]?.includes(payload.status))
      throw AppError.conflict(
        "INVALID_PRIVACY_TRANSITION",
        `This request cannot move from ${row.status} to ${payload.status}.`,
      );
    if (payload.status === "rejected" && !payload.reason)
      throw AppError.unprocessable(
        "REJECTION_REASON_REQUIRED",
        "Provide a reason for rejecting this request.",
      );
    if (
      row.type === "deletion" &&
      payload.status === "completed" &&
      payload.confirmation !== "DELETE CUSTOMER DATA"
    )
      throw AppError.unprocessable(
        "ADMIN_DELETION_CONFIRMATION_REQUIRED",
        "Enter DELETE CUSTOMER DATA to complete anonymization.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    if (
      payload.status === "approved" &&
      row.type === "export" &&
      !row.exportJob
    ) {
      const job: RuntimeValue = await ExportJob.create(
        {
          id: newId(),
          privacyRequestId: row.id,
          requestedBy: row.userId,
          report: "customer_privacy_export",
          filters: { userId: row.userId },
          status: "queued",
        },
        { transaction },
      );
      await addDomainEvent({
        topic: "privacy.export.approved",
        aggregateType: "privacy_request",
        aggregateId: row.id,
        payload: {
          privacyRequestId: row.id,
          exportJobId: job.id,
          userId: row.userId,
        },
        transaction,
      });
    }
    if (
      payload.status === "completed" &&
      row.type === "export" &&
      row.exportJob?.status !== "ready"
    )
      throw AppError.conflict(
        "PRIVACY_EXPORT_NOT_READY",
        "The privacy export must finish before this request can be completed.",
      );
    const user: RuntimeValue = await User.findByPk(row.userId, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user)
      throw AppError.conflict(
        "CUSTOMER_RECORD_MISSING",
        "The customer record required by this request is unavailable.",
      );
    // Captured before anonymization clears the contact fields.
    const recipient = user.email || user.phone;
    const channel = user.email ? "email" : "sms";
    if (payload.status === "completed" && row.type === "deletion")
      await anonymizeCustomer(user, actorId, transaction);
    row.status = payload.status;
    row.reviewedBy = actorId;
    row.reviewedAt = new Date();
    row.reason = payload.reason || row.reason;
    row.metadata = {
      ...row.metadata,
      lastAdminNote: payload.note || null,
      legalRecordsRetained:
        row.type === "deletion" && payload.status === "completed",
    };
    if (["rejected", "completed"].includes(payload.status))
      row.activeKey = null;
    if (payload.status === "completed") row.completedAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    if (
      recipient &&
      ["approved", "rejected", "completed"].includes(payload.status)
    )
      await queueNotification({
        event: `privacy.${row.type}.${payload.status}`,
        channel,
        locale: user.locale,
        recipient,
        payload: {
          name: user.name,
          requestId: row.id,
          status: row.status,
          message:
            payload.customerMessage ||
            `Your ${row.type} request is ${row.status}.`,
        },
        transaction,
      });
    await recordAudit({
      actorId,
      action: "privacy.transition",
      resourceType: "privacy_request",
      resourceId: row.id,
      before,
      after: { status: row.status, version: Number(row.version) },
      metadata: { type: row.type, reason: payload.reason, note: payload.note },
      request,
      transaction,
    });
    return privacyRequestDto(await hydrateRequest(row.id, transaction), {
      admin: true,
    });
  });
}
