import { Op } from "sequelize";
import {
  Order,
  OrderAddress,
  OrderConfirmation,
  OrderEvent,
  OrderItem,
  User,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { env } from "../../config/env.js";
import { sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId, randomToken } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { settingValue } from "../settings/settings.service.js";
import { cancelLockedOrder } from "./admin-order.service.js";

const openStatuses = ["pending", "no_answer", "call_back", "wrong_number"];

/** Outcomes that count as a failed attempt toward auto-cancellation. */
const failedOutcomes = new Set(["no_answer", "wrong_number"]);

export function confirmationDecision(
  outcome: string,
  attemptsAfter: number,
  maxAttempts: number,
) {
  if (outcome === "confirmed") return "confirm" as const;
  if (outcome === "customer_cancelled") return "cancel" as const;
  if (failedOutcomes.has(outcome) && attemptsAfter >= maxAttempts)
    return "auto_cancel" as const;
  return "retry" as const;
}

function queueItemDto(order: RuntimeValue, history: RuntimeValue) {
  const shipping = order.addresses?.find(
    (row: RuntimeValue) => row.type === "shipping",
  );
  return {
    id: order.id,
    reference: order.reference,
    version: order.version,
    createdAt: order.createdAt,
    channel: order.channel,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    confirmationStatus: order.confirmationStatus,
    confirmationAttempts: order.confirmationAttempts,
    nextConfirmationAt: order.nextConfirmationAt,
    riskLevel: order.riskLevel,
    riskScore: order.riskScore,
    riskSignals: order.riskSignals || [],
    duplicateOfOrderId: order.duplicateOfOrderId,
    tags: order.tags || [],
    customer: {
      name: order.customerName,
      phone: order.customerPhone,
      email: order.customerEmail,
    },
    address: shipping
      ? {
          addressLine: shipping.addressLine,
          thana: shipping.thana,
          area: shipping.area,
          district: shipping.district,
          landmark: shipping.landmark,
        }
      : null,
    delivery: { code: order.deliveryCode, label: order.deliveryLabel },
    totals: {
      grand: moneyString(order.grandTotal),
      delivery: moneyString(order.deliveryTotal),
    },
    note: order.note,
    items: (order.items || []).map((item: RuntimeValue) => ({
      id: item.id,
      productName: item.productName,
      variantTitle: item.variantTitle,
      sku: item.sku,
      quantity: item.quantity,
      lineTotal: moneyString(item.lineTotal),
    })),
    attempts: (order.confirmations || []).map((row: RuntimeValue) => ({
      id: row.id,
      method: row.method,
      outcome: row.outcome,
      note: row.note,
      callbackAt: row.callbackAt,
      actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
      createdAt: row.createdAt,
    })),
    history,
  };
}

async function customerHistory(phones: string[]) {
  if (!phones.length) return new Map();
  const rows: RuntimeValue = await Order.findAll({
    where: { customerPhone: { [Op.in]: phones } },
    attributes: [
      "customerPhone",
      "orderStatus",
      "fulfillmentStatus",
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    group: ["customerPhone", "orderStatus", "fulfillmentStatus"],
    raw: true,
  });
  const byPhone = new Map();
  for (const row of rows) {
    const entry = byPhone.get(row.customerPhone) || {
      orders: 0,
      delivered: 0,
      cancelled: 0,
      returnedToOrigin: 0,
    };
    const count = Number(row.count);
    entry.orders += count;
    if (row.fulfillmentStatus === "returned_to_origin")
      entry.returnedToOrigin += count;
    else if (row.orderStatus === "cancelled") entry.cancelled += count;
    if (
      ["delivered", "partially_returned", "returned"].includes(
        row.fulfillmentStatus,
      )
    )
      entry.delivered += count;
    byPhone.set(row.customerPhone, entry);
  }
  return byPhone;
}

export async function listConfirmationQueue(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query, 50);
  const where: RuntimeValue = {
    orderStatus: "placed",
    confirmationStatus: query.status ? query.status : { [Op.in]: openStatuses },
  };
  if (query.riskLevel) where.riskLevel = query.riskLevel;
  if (query.due === "true")
    where[Op.or] = [
      { nextConfirmationAt: null },
      { nextConfirmationAt: { [Op.lte]: new Date() } },
    ];
  const result: RuntimeValue = await Order.findAndCountAll({
    where,
    include: [
      {
        model: OrderItem,
        as: "items",
        attributes: [
          "id",
          "productName",
          "variantTitle",
          "sku",
          "quantity",
          "lineTotal",
        ],
      },
      { model: OrderAddress, as: "addresses" },
      {
        model: OrderConfirmation,
        as: "confirmations",
        include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
      },
    ],
    distinct: true,
    limit,
    offset,
    // Due callbacks first, then oldest orders so nobody waits longest.
    order: [
      [sequelize.literal("nextConfirmationAt IS NULL"), "DESC"],
      ["nextConfirmationAt", "ASC"],
      ["createdAt", "ASC"],
    ],
  });
  const history = await customerHistory([
    ...new Set<string>(
      result.rows.map((row: RuntimeValue) => row.customerPhone),
    ),
  ]);
  const [counts]: RuntimeValue = await Promise.all([
    Order.findAll({
      where: {
        orderStatus: "placed",
        confirmationStatus: { [Op.in]: openStatuses },
      },
      attributes: [
        "riskLevel",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["riskLevel"],
      raw: true,
    }),
  ]);
  return {
    data: result.rows.map((order: RuntimeValue) =>
      queueItemDto(order, history.get(order.customerPhone) || null),
    ),
    meta: {
      ...pageEnvelope(result, page, pageSize).meta,
      byRisk: Object.fromEntries(
        counts.map((row: RuntimeValue) => [row.riskLevel, Number(row.count)]),
      ),
    },
  };
}

async function confirmLockedOrder(
  order: RuntimeValue,
  method: string,
  actorId: string | null,
  note: string | null,
  request: RuntimeValue,
  transaction: RuntimeValue,
) {
  const before = {
    orderStatus: order.orderStatus,
    confirmationStatus: order.confirmationStatus,
  };
  order.confirmationStatus = "confirmed";
  order.confirmedAt = new Date();
  order.nextConfirmationAt = null;
  if (order.orderStatus === "placed") order.orderStatus = "confirmed";
  order.version += 1;
  await order.save({ transaction });
  await OrderEvent.create(
    {
      id: newId(),
      orderId: order.id,
      actorId,
      type: "order_confirmed",
      fromStatus: before.orderStatus,
      toStatus: order.orderStatus,
      message:
        order.locale === "bn"
          ? "আপনার অর্ডার নিশ্চিত হয়েছে।"
          : "Your order is confirmed.",
      public: true,
      metadata: { method, note },
    },
    { transaction },
  );
  await addDomainEvent({
    topic: "order.confirmed",
    aggregateType: "order",
    aggregateId: order.id,
    payload: { orderId: order.id, reference: order.reference, method },
    transaction,
  });
  await queueNotification({
    event: "order.confirmed",
    channel: order.customerEmail ? "email" : "sms",
    locale: order.locale,
    recipient: order.customerEmail || order.customerPhone,
    payload: {
      message:
        order.locale === "bn"
          ? `অর্ডার ${order.reference} নিশ্চিত হয়েছে। শীঘ্রই পাঠানো হবে।`
          : `Order ${order.reference} is confirmed and will be dispatched soon.`,
      orderReference: order.reference,
    },
    transaction,
  });
  await recordAudit({
    actorId,
    action: "order.confirm",
    resourceType: "order",
    resourceId: order.id,
    before,
    after: {
      orderStatus: order.orderStatus,
      confirmationStatus: order.confirmationStatus,
    },
    metadata: { method },
    request,
    transaction,
  });
}

/** Records one confirmation attempt for an order (BE-RISK-001). */
export async function recordConfirmation(
  orderId: string,
  payload: RuntimeValue,
  actorId: string,
  request: RuntimeValue,
) {
  const settings: RuntimeValue = await settingValue("confirmation");
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(orderId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    if (
      payload.version != null &&
      Number(payload.version) !== Number(order.version)
    )
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This order changed. Refresh and review the latest state.",
      );
    if (
      order.orderStatus !== "placed" ||
      !openStatuses.includes(order.confirmationStatus)
    )
      throw AppError.conflict(
        "CONFIRMATION_CLOSED",
        "This order is no longer waiting for confirmation.",
      );
    const attemptsAfter =
      Number(order.confirmationAttempts) +
      (failedOutcomes.has(payload.outcome) ? 1 : 0);
    let decision = confirmationDecision(
      payload.outcome,
      attemptsAfter,
      settings.maxAttempts,
    );
    // Money already collected needs a refund decision, never a silent cancel.
    if (decision === "auto_cancel" && order.paymentStatus !== "unpaid")
      decision = "retry";
    await OrderConfirmation.create(
      {
        id: newId(),
        orderId: order.id,
        actorId,
        method: payload.method || "call",
        outcome: payload.outcome,
        note: payload.note || null,
        callbackAt: payload.callbackAt || null,
      },
      { transaction },
    );
    if (decision === "confirm")
      await confirmLockedOrder(
        order,
        payload.method || "call",
        actorId,
        payload.note || null,
        request,
        transaction,
      );
    else if (decision === "cancel" || decision === "auto_cancel") {
      order.confirmationStatus =
        decision === "cancel" ? "customer_cancelled" : payload.outcome;
      order.confirmationAttempts = attemptsAfter;
      await cancelLockedOrder(
        order,
        decision === "cancel"
          ? payload.note || "Customer cancelled during confirmation call"
          : "Could not be confirmed by phone",
        actorId,
        request,
        transaction,
        decision === "cancel"
          ? "Order cancelled at the customer's request."
          : "Order cancelled because we could not reach you to confirm it.",
      );
    } else {
      order.confirmationStatus = payload.outcome;
      order.confirmationAttempts = attemptsAfter;
      order.nextConfirmationAt =
        payload.callbackAt || new Date(Date.now() + 2 * 3600000);
      order.version += 1;
      await order.save({ transaction });
      await recordAudit({
        actorId,
        action: "order.confirmation_attempt",
        resourceType: "order",
        resourceId: order.id,
        after: {
          outcome: payload.outcome,
          attempts: attemptsAfter,
        },
        request,
        transaction,
      });
    }
    return {
      id: order.id,
      reference: order.reference,
      orderStatus: order.orderStatus,
      confirmationStatus: order.confirmationStatus,
      confirmationAttempts: order.confirmationAttempts,
      version: order.version,
      decision,
    };
  });
}

export async function bulkConfirm(
  ids: string[],
  actorId: string,
  request: RuntimeValue,
) {
  const results = [];
  for (const id of ids) {
    try {
      const result = await recordConfirmation(
        id,
        { outcome: "confirmed", method: "manual" },
        actorId,
        request,
      );
      results.push({ id, ok: true, reference: result.reference });
    } catch (error: RuntimeValue) {
      results.push({
        id,
        ok: false,
        code: error?.code || "CONFIRMATION_FAILED",
        message: error?.message || "Could not confirm this order.",
      });
    }
  }
  return results;
}

/**
 * Issues a single-use customer confirmation link (SMS) for a COD order.
 * The token embeds the order ID so lookup is a primary-key read; only its
 * hash is stored.
 */
export async function issueConfirmationLink(
  order: RuntimeValue,
  transaction: RuntimeValue,
) {
  const settings: RuntimeValue = await settingValue(
    "confirmation",
    transaction,
  );
  if (!settings.enabled || !settings.smsLinkEnabled) return;
  const secret = randomToken(24);
  order.metadata = {
    ...order.metadata,
    confirmationLink: {
      hash: sha256(secret),
      expiresAt: new Date(
        Date.now() + Number(settings.linkTtlHours) * 3600000,
      ).toISOString(),
    },
  };
  await order.save({ transaction });
  const confirmUrl = `${env.PUBLIC_ORIGIN.replace(/\/$/, "")}/${order.locale}/confirm/${order.id}.${secret}`;
  await queueNotification({
    event: "order.confirmation_request",
    channel: "sms",
    locale: order.locale,
    recipient: order.customerPhone,
    payload: {
      orderReference: order.reference,
      total: `BDT ${moneyString(order.grandTotal)}`,
      confirmUrl,
    },
    transaction,
  });
}

function parseToken(token: string) {
  const match = /^([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{20,100})$/.exec(
    String(token || ""),
  );
  if (!match)
    throw AppError.notFound("This confirmation link is invalid or expired.");
  return { orderId: match[1], secret: match[2] };
}

async function orderForToken(token: string, transaction: RuntimeValue = null) {
  const { orderId, secret } = parseToken(token);
  const order: RuntimeValue = await Order.findByPk(orderId, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  const link = order?.metadata?.confirmationLink;
  if (
    !order ||
    !link?.hash ||
    link.hash !== sha256(secret) ||
    new Date(link.expiresAt).getTime() < Date.now()
  )
    throw AppError.notFound("This confirmation link is invalid or expired.");
  return order;
}

function publicConfirmationDto(order: RuntimeValue) {
  return {
    reference: order.reference,
    total: moneyString(order.grandTotal),
    currency: order.currency,
    orderStatus: order.orderStatus,
    confirmationStatus: order.confirmationStatus,
  };
}

export async function lookupConfirmation(token: string) {
  return publicConfirmationDto(await orderForToken(token));
}

export async function confirmByToken(token: string, request: RuntimeValue) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order = await orderForToken(token, transaction);
    if (order.confirmationStatus === "confirmed")
      return publicConfirmationDto(order);
    if (
      order.orderStatus !== "placed" ||
      !openStatuses.includes(order.confirmationStatus)
    )
      throw AppError.conflict(
        "CONFIRMATION_CLOSED",
        "This order can no longer be confirmed online. Please contact us.",
      );
    await OrderConfirmation.create(
      {
        id: newId(),
        orderId: order.id,
        actorId: null,
        method: "sms_link",
        outcome: "confirmed",
      },
      { transaction },
    );
    order.metadata = { ...order.metadata, confirmationLink: null };
    await confirmLockedOrder(
      order,
      "sms_link",
      null,
      null,
      request,
      transaction,
    );
    return publicConfirmationDto(order);
  });
}

/** Worker job: cancels orders left unconfirmed past the configured window. */
export async function cancelStaleUnconfirmedOrders(limit: number = 50) {
  const settings: RuntimeValue = await settingValue("confirmation");
  if (!settings.enabled) return 0;
  const cutoff = new Date(
    Date.now() - Number(settings.maxPendingHours) * 3600000,
  );
  const stale: RuntimeValue = await Order.findAll({
    where: {
      orderStatus: "placed",
      confirmationStatus: { [Op.in]: openStatuses },
      paymentStatus: "unpaid",
      placedAt: { [Op.lt]: cutoff },
    },
    attributes: ["id"],
    limit,
    order: [["placedAt", "ASC"]],
  });
  let cancelled = 0;
  for (const { id } of stale) {
    await sequelize.transaction(async (transaction: RuntimeValue) => {
      const order: RuntimeValue = await Order.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      // Re-check under lock: staff may have confirmed it meanwhile.
      if (
        !order ||
        order.orderStatus !== "placed" ||
        order.paymentStatus !== "unpaid" ||
        !openStatuses.includes(order.confirmationStatus)
      )
        return;
      await OrderConfirmation.create(
        {
          id: newId(),
          orderId: order.id,
          actorId: null,
          method: "auto",
          outcome: "auto_cancelled",
          note: `Unconfirmed after ${settings.maxPendingHours} hours`,
        },
        { transaction },
      );
      await cancelLockedOrder(
        order,
        `Unconfirmed after ${settings.maxPendingHours} hours`,
        null,
        null,
        transaction,
        "Order cancelled because it was not confirmed in time.",
      );
      await notifyStaff("orders", {
        event: "order.auto_cancelled",
        title: `Order ${order.reference} auto-cancelled`,
        message: `It was not confirmed within ${settings.maxPendingHours} hours; reserved stock was released.`,
        link: `/admin/orders/${order.id}`,
        severity: "warning",
        data: { orderId: order.id, orderReference: order.reference },
        transaction,
      });
      cancelled += 1;
    });
  }
  return cancelled;
}
