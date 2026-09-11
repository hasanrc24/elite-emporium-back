import { Op } from "sequelize";
import {
  IdempotencyRecord,
  MediaAsset,
  Order,
  ReturnEvent,
  ReturnItem,
  ReturnMedia,
  ReturnRequest,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId, returnReference } from "../../lib/ids.js";
import { money, moneyString } from "../../lib/money.js";
import { normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import {
  calculateReturnEligibility,
  eligibilityDto,
  refundableLineAmount,
  resolveReturnOrderAccess,
} from "./return-policy.service.js";
import {
  loadReturnDetail,
  returnDetailInclude,
  returnDto,
} from "./return.presenter.js";

function assertResolution(type: RuntimeValue, resolution: RuntimeValue) {
  const expected = type === "exchange" ? "exchange" : "refund";
  if (resolution !== expected)
    throw AppError.unprocessable(
      "INVALID_RETURN_RESOLUTION",
      `${type === "exchange" ? "Exchange" : "Return"} requests must use ${expected} resolution.`,
    );
}

function requestActorKey(payload: RuntimeValue, userId: RuntimeValue) {
  if (userId) return userId;
  const phone: RuntimeValue = normalizePhone(payload.phone);
  return `guest:${sha256(`${String(payload.orderReference || "").toUpperCase()}|${phone || ""}`)}`;
}

async function validateEvidence(
  mediaIds: RuntimeValue,
  { userId, orderId, transaction }: RuntimeValue,
) {
  if (!mediaIds?.length) return [];
  const uniqueIds: RuntimeValue = [...new Set(mediaIds)];
  if (uniqueIds.length !== mediaIds.length)
    throw AppError.unprocessable(
      "DUPLICATE_RETURN_MEDIA",
      "Each evidence file can be attached only once.",
    );
  const media: RuntimeValue = await MediaAsset.findAll({
    where: { id: { [Op.in]: uniqueIds }, privacy: "private", status: "ready" },
    include: [
      {
        model: ReturnRequest,
        as: "returns",
        attributes: ["id"],
        through: { attributes: [] },
        required: false,
      },
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (media.length !== uniqueIds.length)
    throw AppError.unprocessable(
      "INVALID_RETURN_MEDIA",
      "One or more evidence files are unavailable.",
    );
  const byId = new Map(media.map((asset: RuntimeValue) => [asset.id, asset]));
  const ordered: RuntimeValue = uniqueIds.map((id: RuntimeValue) =>
    byId.get(id),
  );
  for (const asset of ordered) {
    const purposeMatches = asset.metadata?.purpose === "return";
    const ownerMatches = userId
      ? asset.uploaderId === userId
      : !asset.uploaderId && asset.metadata?.guestOrderId === orderId;
    if (!purposeMatches || !ownerMatches || asset.returns?.length)
      throw AppError.unprocessable(
        "INVALID_RETURN_MEDIA",
        "One or more evidence files cannot be used for this request.",
      );
  }
  return ordered;
}

/**
 * @param {{ orderId?: string | null, orderReference?: string | null, phone?: string | null, userId?: string | null }} input
 */
export async function getReturnEligibility({
  orderId = null,
  orderReference = null,
  phone = null,
  userId = null,
}: RuntimeValue) {
  const order: RuntimeValue = await resolveReturnOrderAccess({
    orderId,
    orderReference,
    phone,
    userId,
  });
  const eligibility: RuntimeValue = await calculateReturnEligibility(order);
  if (!userId && !eligibility.policy.guestReturns)
    throw AppError.notFound("Order not found.");
  return eligibilityDto(order, eligibility);
}

export async function verifyGuestReturnUpload(
  orderReference: RuntimeValue,
  phone: RuntimeValue,
) {
  const order: RuntimeValue = await resolveReturnOrderAccess({
    orderReference,
    phone,
    userId: null,
  });
  const eligibility: RuntimeValue = await calculateReturnEligibility(order);
  if (!eligibility.policy.guestReturns || !eligibility.eligible)
    throw AppError.unprocessable(
      eligibility.ineligibleReason || "RETURN_NOT_ELIGIBLE",
      "This order is not eligible for an online return request.",
    );
  return order;
}

export async function createReturn(
  payload: RuntimeValue,
  userId: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue,
) {
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  assertResolution(payload.type, payload.resolution);
  const actorKey: RuntimeValue = requestActorKey(payload, userId);
  const requestHash: RuntimeValue = sha256(
    canonicalJson({
      ...payload,
      phone: userId ? undefined : normalizePhone(payload.phone),
    }),
  );
  const result: RuntimeValue = await sequelize.transaction(
    async (transaction: RuntimeValue) => {
      const [idempotency]: RuntimeValue = await IdempotencyRecord.findOrCreate({
        where: { scope: "returns.create", key: idempotencyKey, actorKey },
        defaults: {
          id: newId(),
          scope: "returns.create",
          key: idempotencyKey,
          actorKey,
          requestHash,
          expiresAt: new Date(Date.now() + 365 * 86400000),
        },
        transaction,
      });
      await idempotency.reload({ transaction, lock: transaction.LOCK.UPDATE });
      if (idempotency.requestHash !== requestHash)
        throw AppError.conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "This return key was already used for a different request.",
        );
      if (idempotency.responseBody?.returnId)
        return { returnId: idempotency.responseBody.returnId, replay: true };

      const order: RuntimeValue = await resolveReturnOrderAccess({
        orderId: payload.orderId,
        orderReference: payload.orderReference,
        phone: payload.phone,
        userId,
        transaction,
        lock: true,
      });
      const eligibility: RuntimeValue = await calculateReturnEligibility(
        order,
        {
          transaction,
          lock: true,
        },
      );
      if (!userId && !eligibility.policy.guestReturns)
        throw AppError.notFound("Order not found.");
      if (!eligibility.eligible)
        throw AppError.unprocessable(
          eligibility.ineligibleReason || "RETURN_NOT_ELIGIBLE",
          "This order is not eligible for a return request.",
        );

      const selectedIds = new Set(
        payload.items.map((item: RuntimeValue) => item.orderItemId),
      );
      if (selectedIds.size !== payload.items.length)
        throw AppError.unprocessable(
          "DUPLICATE_RETURN_ITEM",
          "Each order item can appear only once.",
        );
      const byId = new Map(
        eligibility.items.map((item: RuntimeValue) => [item.orderItemId, item]),
      );
      let estimate: RuntimeValue = money(0);
      for (const selected of payload.items) {
        const eligibleItem: RuntimeValue = byId.get(selected.orderItemId);
        if (!eligibleItem || !eligibleItem.eligible)
          throw AppError.unprocessable(
            "ITEM_NOT_RETURNABLE",
            "One or more selected items are not returnable.",
          );
        if (selected.quantity > eligibleItem.eligibleQuantity)
          throw AppError.unprocessable(
            "RETURN_QUANTITY_EXCEEDED",
            `Only ${eligibleItem.eligibleQuantity} of ${eligibleItem.sku} can be requested.`,
          );
        estimate = estimate.plus(
          refundableLineAmount(eligibleItem.orderItem, selected.quantity),
        );
      }
      const media: RuntimeValue = await validateEvidence(
        payload.mediaIds || [],
        {
          userId,
          orderId: order.id,
          transaction,
        },
      );
      const policySnapshot: RuntimeValue = {
        ...eligibility.snapshot,
        requestedRefundEstimate: moneyString(estimate),
      };
      const row: RuntimeValue = await ReturnRequest.create(
        {
          id: newId(),
          reference: returnReference(),
          orderId: order.id,
          userId: userId || null,
          type: payload.type,
          status: "requested",
          reason: payload.reason,
          customerNote: payload.customerNote || null,
          resolution: payload.resolution,
          requestedAt: new Date(),
          policySnapshot,
          version: 1,
        },
        { transaction },
      );
      for (const selected of payload.items) {
        await ReturnItem.create(
          {
            id: newId(),
            returnId: row.id,
            orderItemId: selected.orderItemId,
            quantity: selected.quantity,
            reason: selected.reason || payload.reason,
            resolution: payload.resolution,
          },
          { transaction },
        );
      }
      if (media.length) {
        await ReturnMedia.bulkCreate(
          media.map((asset: RuntimeValue, index: RuntimeValue) => ({
            returnId: row.id,
            mediaId: asset.id,
            displayOrder: index,
          })),
          { transaction },
        );
      }
      await ReturnEvent.create(
        {
          id: newId(),
          returnId: row.id,
          actorId: userId || null,
          type: "requested",
          message: `${payload.type === "exchange" ? "Exchange" : "Return"} request submitted.`,
          public: true,
          metadata: {
            orderReference: order.reference,
            itemCount: payload.items.length,
          },
        },
        { transaction },
      );
      await addDomainEvent({
        topic: "return.requested",
        aggregateType: "return",
        aggregateId: row.id,
        payload: {
          returnId: row.id,
          reference: row.reference,
          orderId: order.id,
          orderReference: order.reference,
          type: row.type,
          resolution: row.resolution,
        },
        transaction,
      });
      await queueNotification({
        event: "return.requested",
        channel: "dashboard",
        recipient: "staff:returns",
        payload: {
          message: `${row.reference} requires review.`,
          returnReference: row.reference,
          orderReference: order.reference,
        },
        transaction,
      });
      if (order.customerEmail || order.customerPhone) {
        await queueNotification({
          event: "return.requested",
          channel: order.customerEmail ? "email" : "sms",
          locale: order.locale,
          recipient: order.customerEmail || order.customerPhone,
          payload: {
            message: `Return request ${row.reference} was submitted for order ${order.reference}.`,
            returnReference: row.reference,
            orderReference: order.reference,
          },
          transaction,
        });
      }
      await recordAudit({
        actorId: userId || null,
        action: "return.create",
        resourceType: "return",
        resourceId: row.id,
        after: {
          reference: row.reference,
          orderId: order.id,
          type: row.type,
          resolution: row.resolution,
          status: row.status,
          items: payload.items.map((item: RuntimeValue) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
          })),
        },
        metadata: { idempotencyKey, guest: !userId },
        request,
        transaction,
      });
      idempotency.responseStatus = 201;
      idempotency.responseBody = { returnId: row.id };
      await idempotency.save({ transaction });
      return { returnId: row.id, replay: false };
    },
  );
  const data: RuntimeValue = await loadReturnDetail(result.returnId);
  if (!data) throw AppError.notFound("Return request not found.");
  return data;
}

export async function listReturns(userId: RuntimeValue, query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = { userId };
  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;
  const result: RuntimeValue = await ReturnRequest.findAndCountAll({
    where,
    include: returnDetailInclude,
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => returnDto(row)),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getReturn(id: RuntimeValue, userId: RuntimeValue) {
  const row: RuntimeValue = await ReturnRequest.findOne({
    where: { id, userId },
    include: returnDetailInclude,
    order: [[{ model: ReturnEvent, as: "events" }, "createdAt", "ASC"]],
  });
  if (!row) throw AppError.notFound("Return request not found.");
  return returnDto(row);
}

export async function guestLookup(payload: RuntimeValue) {
  const phone: RuntimeValue = normalizePhone(payload.phone);
  if (!phone) throw AppError.notFound("Return request not found.");
  const order: RuntimeValue = await Order.findOne({
    where: {
      reference: payload.orderReference,
      customerPhone: phone,
      userId: null,
    },
  });
  if (!order) throw AppError.notFound("Return request not found.");
  const where: RuntimeValue = {
    orderId: order.id,
    ...(payload.returnReference ? { reference: payload.returnReference } : {}),
  };
  const rows: RuntimeValue = await ReturnRequest.findAll({
    where,
    include: returnDetailInclude,
    order: [["createdAt", "DESC"]],
  });
  if (!rows.length) throw AppError.notFound("Return request not found.");
  return payload.returnReference
    ? returnDto(rows[0])
    : rows.map((row: RuntimeValue) => returnDto(row));
}

export async function cancelReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  userId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    if (userId) {
      if (row.userId !== userId)
        throw AppError.notFound("Return request not found.");
    } else {
      const phone: RuntimeValue = normalizePhone(payload.phone);
      if (
        row.userId ||
        !phone ||
        row.order.reference !== payload.orderReference ||
        row.order.customerPhone !== phone
      )
        throw AppError.notFound("Return request not found.");
    }
    if (Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This return request changed. Refresh and review its latest state.",
      );
    if (row.status === "cancelled")
      return returnDto(
        (await ReturnRequest.findByPk(row.id, {
          include: returnDetailInclude,
          transaction,
        }))!,
      );
    if (row.status !== "requested")
      throw AppError.conflict(
        "RETURN_NOT_CANCELLABLE",
        "This return request can no longer be cancelled online.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.status = "cancelled";
    row.cancelledAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    await ReturnEvent.create(
      {
        id: newId(),
        returnId: row.id,
        actorId: userId || null,
        type: "cancelled",
        message: "Return request cancelled by the customer.",
        public: true,
        metadata: { reason: payload.reason },
      },
      { transaction },
    );
    await addDomainEvent({
      topic: "return.cancelled",
      aggregateType: "return",
      aggregateId: row.id,
      payload: {
        returnId: row.id,
        orderId: row.orderId,
        reason: payload.reason,
      },
      transaction,
    });
    await recordAudit({
      actorId: userId || null,
      action: "return.cancel",
      resourceType: "return",
      resourceId: row.id,
      before,
      after: { status: row.status, version: row.version },
      metadata: { reason: payload.reason, guest: !userId },
      request,
      transaction,
    });
    const detail: RuntimeValue = await ReturnRequest.findByPk(row.id, {
      include: returnDetailInclude,
      transaction,
    });
    return returnDto(detail);
  });
}
