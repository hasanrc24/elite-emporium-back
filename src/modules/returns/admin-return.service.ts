import { Op } from "sequelize";
import {
  InventoryLevel,
  InventoryMovement,
  MediaAsset,
  Order,
  OrderAddress,
  OrderEvent,
  OrderItem,
  Payment,
  Product,
  ProductTranslation,
  ProductVariant,
  Refund,
  ReturnEvent,
  ReturnItem,
  ReturnRequest,
  StockLocation,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId, orderReference } from "../../lib/ids.js";
import { money, moneyString } from "../../lib/money.js";
import { dateRangeWhere } from "../../lib/date-range.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { effectivePrice, isSaleActive } from "../catalog/pricing.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { refundableLineAmount } from "./return-policy.service.js";
import {
  loadReturnDetail,
  returnDetailInclude,
  returnDto,
} from "./return.presenter.js";

function assertVersion(row: RuntimeValue, version: RuntimeValue) {
  if (Number(version) !== Number(row.version))
    throw AppError.conflict(
      "VERSION_CONFLICT",
      "This return request changed. Refresh and review the latest state.",
    );
}

async function detailWithinTransaction(
  id: RuntimeValue,
  transaction: RuntimeValue,
) {
  const row: RuntimeValue = await ReturnRequest.findByPk(id, {
    include: returnDetailInclude,
    order: [[{ model: ReturnEvent, as: "events" }, "createdAt", "ASC"]],
    transaction,
  });
  return returnDto(row, { internal: true });
}

async function recordReturnTransition({
  row,
  actorId,
  type,
  message,
  publicEvent = true,
  metadata = null,
  request,
  before,
  transaction,
}: RuntimeValue) {
  await ReturnEvent.create(
    {
      id: newId(),
      returnId: row.id,
      actorId,
      type,
      message,
      public: publicEvent,
      metadata,
    },
    { transaction },
  );
  await addDomainEvent({
    topic: `return.${type}`,
    aggregateType: "return",
    aggregateId: row.id,
    payload: {
      returnId: row.id,
      reference: row.reference,
      orderId: row.orderId,
      status: row.status,
      type,
    },
    transaction,
  });
  if (publicEvent && row.order) {
    await queueNotification({
      event: `return.${type}`,
      channel: row.order.customerEmail ? "email" : "sms",
      locale: row.order.locale,
      recipient: row.order.customerEmail || row.order.customerPhone,
      payload: {
        message,
        returnReference: row.reference,
        orderReference: row.order.reference,
      },
      transaction,
    });
  }
  await recordAudit({
    actorId,
    action: `return.${type}`,
    resourceType: "return",
    resourceId: row.id,
    before,
    after: {
      status: row.status,
      refundAmount:
        row.refundAmount == null ? null : moneyString(row.refundAmount),
      version: Number(row.version),
    },
    metadata,
    request,
    transaction,
  });
}

export async function listAdminReturns(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;
  if (query.resolution) where.resolution = query.resolution;
  Object.assign(where, dateRangeWhere(query));
  if (query.search) {
    const search: RuntimeValue = String(query.search).slice(0, 100);
    where[Op.or] = [
      { reference: { [Op.like]: `%${search}%` } },
      { "$order.reference$": { [Op.like]: `%${search}%` } },
      { "$order.customerName$": { [Op.like]: `%${search}%` } },
      { "$order.customerPhone$": { [Op.like]: `%${search}%` } },
    ];
  }
  const result: RuntimeValue = await ReturnRequest.findAndCountAll({
    where,
    include: [
      {
        model: Order,
        as: "order",
        required: true,
        include: [{ model: Payment, as: "payments" }],
      },
      {
        model: ReturnItem,
        as: "items",
        include: [{ model: OrderItem, as: "orderItem" }],
      },
      { model: Refund, as: "refund", required: false },
      {
        model: MediaAsset,
        as: "media",
        through: { attributes: ["displayOrder"] },
      },
    ],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) =>
      returnDto(row, { internal: true }),
    ),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getAdminReturn(id: RuntimeValue) {
  const data: RuntimeValue = await loadReturnDetail(id, { internal: true });
  if (!data) throw AppError.notFound("Return request not found.");
  return data;
}

export async function startReview(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (row.status !== "requested")
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "Only a requested return can enter review.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.status = "under_review";
    row.version += 1;
    await row.save({ transaction });
    await recordReturnTransition({
      row,
      actorId,
      type: "under_review",
      message: payload.message || "Your return request is being reviewed.",
      publicEvent: payload.public,
      metadata: { note: payload.note || null },
      request,
      before,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

async function maximumItemRefund(row: RuntimeValue, transaction: RuntimeValue) {
  const items: RuntimeValue = await ReturnItem.findAll({
    where: { returnId: row.id },
    include: [{ model: OrderItem, as: "orderItem" }],
    order: [["id", "ASC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return items.reduce(
    (sum: RuntimeValue, item: RuntimeValue) =>
      sum.plus(refundableLineAmount(item.orderItem, Number(item.quantity))),
    money(0),
  );
}

async function maximumPaymentRefund(
  orderId: RuntimeValue,
  transaction: RuntimeValue,
) {
  const payments: RuntimeValue = await Payment.findAll({
    where: { orderId, status: { [Op.in]: ["paid", "partially_refunded"] } },
    order: [["id", "ASC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  let available: RuntimeValue = money(0);
  const capacities: RuntimeValue = [];
  for (const payment of payments) {
    const refunds: RuntimeValue = await Refund.findAll({
      where: {
        paymentId: payment.id,
        status: { [Op.in]: ["pending", "processing", "completed"] },
      },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const committed: RuntimeValue = refunds.reduce(
      (sum: RuntimeValue, refund: RuntimeValue) => sum.plus(refund.amount),
      money(0),
    );
    const remaining: RuntimeValue = money(payment.amount).minus(committed);
    if (remaining.greaterThan(available)) available = remaining;
    capacities.push({
      paymentId: payment.id,
      method: payment.method,
      available: moneyString(remaining.isPositive() ? remaining : 0),
    });
  }
  return { available, capacities };
}

export async function approveReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (!["requested", "under_review"].includes(row.status))
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "This return request cannot be approved from its current state.",
      );
    const before: RuntimeValue = {
      status: row.status,
      refundAmount: row.refundAmount,
      version: Number(row.version),
    };
    if (row.resolution === "refund") {
      const requestedAmount: RuntimeValue = money(payload.refundAmount);
      const itemMaximum: RuntimeValue = await maximumItemRefund(
        row,
        transaction,
      );
      const payment: RuntimeValue = await maximumPaymentRefund(
        row.orderId,
        transaction,
      );
      const maximum = itemMaximum.lessThan(payment.available)
        ? itemMaximum
        : payment.available;
      if (
        !requestedAmount.greaterThan(0) ||
        requestedAmount.greaterThan(maximum)
      )
        throw AppError.unprocessable(
          "RETURN_REFUND_LIMIT_EXCEEDED",
          `The maximum approvable refund is ${moneyString(maximum)}.`,
          { refundAmount: [`Enter ${moneyString(maximum)} or less.`] },
        );
      row.refundAmount = moneyString(requestedAmount);
      row.policySnapshot = {
        ...row.policySnapshot,
        approvedRefundMaximum: moneyString(maximum),
        paymentCapacities: payment.capacities,
      };
    } else {
      if (
        payload.refundAmount != null &&
        money(payload.refundAmount).greaterThan(0)
      )
        throw AppError.unprocessable(
          "EXCHANGE_REFUND_NOT_ALLOWED",
          "Use the exchange price-difference workflow after receiving the item.",
        );
      row.refundAmount = null;
    }
    row.status = "approved";
    row.approvedAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    await recordReturnTransition({
      row,
      actorId,
      type: "approved",
      message: payload.message || "Your return request was approved.",
      publicEvent: true,
      metadata: {
        note: payload.note || null,
        refundAmount:
          row.refundAmount == null ? null : moneyString(row.refundAmount),
      },
      request,
      before,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function rejectReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (!["requested", "under_review"].includes(row.status))
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "This return request cannot be rejected from its current state.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.status = "rejected";
    row.rejectionReason = payload.reason;
    row.rejectedAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    await recordReturnTransition({
      row,
      actorId,
      type: "rejected",
      message: payload.message || "Your return request was not approved.",
      publicEvent: true,
      metadata: {
        reason: payload.reason,
        internalNote: payload.internalNote || null,
      },
      request,
      before,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function markReturnInTransit(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (row.status !== "approved")
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "Only an approved return can be marked in transit.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.status = "in_transit";
    row.version += 1;
    await row.save({ transaction });
    await recordReturnTransition({
      row,
      actorId,
      type: "in_transit",
      message: payload.message || "Your returned item is in transit to us.",
      publicEvent: true,
      metadata: {
        courier: payload.courier || null,
        trackingNumber: payload.trackingNumber || null,
        trackingUrl: payload.trackingUrl || null,
      },
      request,
      before,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function receiveReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (!["approved", "in_transit"].includes(row.status))
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "This return request cannot be received from its current state.",
      );
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.status = "received";
    row.receivedAt = payload.receivedAt
      ? new Date(payload.receivedAt)
      : new Date();
    row.version += 1;
    await row.save({ transaction });
    await recordReturnTransition({
      row,
      actorId,
      type: "received",
      message:
        payload.message ||
        "We received your returned item and will inspect it.",
      publicEvent: true,
      metadata: { receivedAt: row.receivedAt, note: payload.note || null },
      request,
      before,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function inspectReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (row.status !== "received")
      throw AppError.conflict(
        "RETURN_NOT_RECEIVED",
        "Receive the return before recording inspection decisions.",
      );
    const items: RuntimeValue = await ReturnItem.findAll({
      where: { returnId: row.id },
      include: [{ model: OrderItem, as: "orderItem" }],
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const incoming = new Map(
      payload.items.map((item: RuntimeValue) => [item.returnItemId, item]),
    );
    if (
      incoming.size !== payload.items.length ||
      incoming.size !== items.length ||
      items.some((item: RuntimeValue) => !incoming.has(item.id))
    )
      throw AppError.unprocessable(
        "INCOMPLETE_INSPECTION",
        "Record exactly one inspection decision for every return item.",
      );

    const operations: RuntimeValue = items
      .map((item: RuntimeValue) => ({ item, decision: incoming.get(item.id) }))
      .sort((left: RuntimeValue, right: RuntimeValue) => {
        const variantOrder: RuntimeValue = String(
          left.item.orderItem.variantId,
        ).localeCompare(String(right.item.orderItem.variantId));
        return (
          variantOrder ||
          String(left.decision.locationId || "").localeCompare(
            String(right.decision.locationId || ""),
          )
        );
      });
    const locationIds: RuntimeValue = [
      ...new Set(
        operations
          .filter(({ decision }: RuntimeValue) => decision.restock)
          .map(({ decision }: RuntimeValue) => decision.locationId),
      ),
    ].sort();
    const locations: RuntimeValue = locationIds.length
      ? await StockLocation.findAll({
          where: { id: { [Op.in]: locationIds }, active: true },
          order: [["id", "ASC"]],
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : [];
    const locationById = new Map(
      locations.map((location: RuntimeValue) => [location.id, location]),
    );
    if (locations.length !== locationIds.length)
      throw AppError.unprocessable(
        "INVALID_RESTOCK_LOCATION",
        "Choose an active stock location for every restocked item.",
      );

    const movements: RuntimeValue = [];
    for (const { item, decision } of operations) {
      if (
        item.restockedAt &&
        (!decision.restock || decision.locationId !== item.restockLocationId)
      )
        throw AppError.conflict(
          "RESTOCK_DECISION_IMMUTABLE",
          "Inventory already received for this item; its restock decision cannot be reversed.",
        );
      item.condition = decision.condition;
      item.inspectionNote = decision.note || null;
      item.restock = decision.restock;
      item.restockLocationId = decision.restock ? decision.locationId : null;
      if (decision.restock && !item.restockedAt) {
        const location: RuntimeValue = locationById.get(decision.locationId);
        const [level]: RuntimeValue = await InventoryLevel.findOrCreate({
          where: {
            variantId: item.orderItem.variantId,
            locationId: location.id,
          },
          defaults: {
            id: newId(),
            variantId: item.orderItem.variantId,
            locationId: location.id,
            onHand: 0,
            reserved: 0,
            lowStockThreshold: 3,
            version: 1,
          },
          transaction,
        });
        await level.reload({ transaction, lock: transaction.LOCK.UPDATE });
        const beforeOnHand: RuntimeValue = Number(level.onHand);
        level.onHand = beforeOnHand + Number(item.quantity);
        level.version += 1;
        await level.save({ transaction });
        item.restockedAt = new Date();
        await InventoryMovement.create(
          {
            id: newId(),
            variantId: item.orderItem.variantId,
            locationId: location.id,
            orderId: row.orderId,
            returnId: row.id,
            actorId,
            quantityDelta: Number(item.quantity),
            reservedDelta: 0,
            onHandBefore: beforeOnHand,
            balanceAfter: Number(level.onHand),
            reservedAfter: Number(level.reserved),
            reason: "return_restocked",
            note: decision.note || null,
            correlationId: `return:${row.id}:${item.id}`,
          },
          { transaction },
        );
        movements.push({
          returnItemId: item.id,
          variantId: item.orderItem.variantId,
          locationId: location.id,
          quantity: Number(item.quantity),
        });
      }
      await item.save({ transaction });
    }
    const before: RuntimeValue = {
      status: row.status,
      version: Number(row.version),
    };
    row.version += 1;
    await row.save({ transaction });
    await ReturnEvent.create(
      {
        id: newId(),
        returnId: row.id,
        actorId,
        type: "inspected",
        message: payload.publicMessage || "Returned items were inspected.",
        public: true,
        metadata: {
          movements,
          decisions: payload.items.map((item: RuntimeValue) => ({
            returnItemId: item.returnItemId,
            condition: item.condition,
            restock: item.restock,
            locationId: item.locationId || null,
          })),
        },
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "return.inspect",
      resourceType: "return",
      resourceId: row.id,
      before,
      after: { status: row.status, version: row.version, movements },
      request,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

function availableVariantQuantity(variant: RuntimeValue) {
  return (variant.inventoryLevels || []).reduce(
    (sum: RuntimeValue, level: RuntimeValue) =>
      sum + Math.max(0, Number(level.onHand) - Number(level.reserved)),
    0,
  );
}

export async function createExchangeDraft(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [
        {
          model: Order,
          as: "order",
          include: [{ model: OrderAddress, as: "addresses" }],
        },
        {
          model: ReturnItem,
          as: "items",
          include: [{ model: OrderItem, as: "orderItem" }],
        },
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (row.resolution !== "exchange" || row.status !== "received")
      throw AppError.conflict(
        "EXCHANGE_NOT_READY",
        "The exchange must be received and inspected before creating its replacement draft.",
      );
    if (row.replacementOrderId)
      throw AppError.conflict(
        "EXCHANGE_DRAFT_EXISTS",
        "A replacement order is already linked to this exchange.",
      );
    if (
      row.items.some(
        (item: RuntimeValue) => !item.condition || item.restock == null,
      )
    )
      throw AppError.conflict(
        "INSPECTION_REQUIRED",
        "Complete the inspection decisions before creating a replacement order.",
      );
    const uniqueVariants: RuntimeValue = [
      ...new Set(payload.items.map((item: RuntimeValue) => item.variantId)),
    ];
    if (uniqueVariants.length !== payload.items.length)
      throw AppError.unprocessable(
        "DUPLICATE_REPLACEMENT_VARIANT",
        "Combine quantities for duplicate replacement variants.",
      );
    const variants: RuntimeValue = await ProductVariant.findAll({
      where: {
        id: { [Op.in]: uniqueVariants },
        active: true,
        status: "active",
      },
      include: [
        {
          model: Product,
          as: "product",
          where: { status: "published" },
          include: [{ model: ProductTranslation, as: "translations" }],
        },
        { model: InventoryLevel, as: "inventoryLevels" },
      ],
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (variants.length !== uniqueVariants.length)
      throw AppError.unprocessable(
        "INVALID_REPLACEMENT_VARIANT",
        "One or more replacement variants are unavailable.",
      );
    const byId = new Map(
      variants.map((variant: RuntimeValue) => [variant.id, variant]),
    );
    const lines: RuntimeValue = payload.items.map((item: RuntimeValue) => {
      const variant: RuntimeValue = byId.get(item.variantId);
      if (
        variant.stockPolicy === "deny" &&
        item.quantity > availableVariantQuantity(variant)
      )
        throw AppError.unprocessable(
          "INSUFFICIENT_REPLACEMENT_STOCK",
          `Only ${availableVariantQuantity(variant)} of ${variant.sku} are currently available.`,
        );
      const unitPrice: RuntimeValue = effectivePrice(variant);
      const translation =
        variant.product.translations.find(
          (value: RuntimeValue) => value.locale === row.order.locale,
        ) ||
        variant.product.translations.find(
          (value: RuntimeValue) => value.locale === "en",
        );
      return {
        variant,
        quantity: item.quantity,
        unitPrice,
        translation,
        total: unitPrice.mul(item.quantity).toDecimalPlaces(2),
      };
    });
    const credit: RuntimeValue = row.items.reduce(
      (sum: RuntimeValue, item: RuntimeValue) =>
        sum.plus(refundableLineAmount(item.orderItem, Number(item.quantity))),
      money(0),
    );
    const subtotal: RuntimeValue = lines.reduce(
      (sum: RuntimeValue, line: RuntimeValue) => sum.plus(line.total),
      money(0),
    );
    const appliedCredit = credit.lessThan(subtotal) ? credit : subtotal;
    const amountDue: RuntimeValue = subtotal.minus(appliedCredit);
    const refundDue: RuntimeValue = credit.greaterThan(subtotal)
      ? credit.minus(subtotal)
      : money(0);
    const shippingAddress: RuntimeValue = row.order.addresses.find(
      (address: RuntimeValue) => address.type === "shipping",
    );
    const replacement: RuntimeValue = await Order.create(
      {
        id: newId(),
        userId: row.order.userId,
        reference: orderReference(),
        source: "admin",
        orderStatus: "draft",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        paymentMethod: row.order.paymentMethod,
        customerName: row.order.customerName,
        customerPhone: row.order.customerPhone,
        customerEmail: row.order.customerEmail,
        address: row.order.address,
        deliveryCode: "exchange_replacement",
        deliveryLabel: "Exchange replacement",
        subtotal: moneyString(subtotal),
        discountTotal: moneyString(appliedCredit),
        deliveryTotal: "0.00",
        taxTotal: "0.00",
        grandTotal: moneyString(amountDue),
        currency: row.order.currency,
        locale: row.order.locale,
        note: payload.note || null,
        metadata: {
          exchangeReturnId: row.id,
          originalOrderId: row.orderId,
          exchangeCredit: moneyString(credit),
          amountDue: moneyString(amountDue),
          refundDue: moneyString(refundDue),
          inventoryReserved: false,
        },
        version: 1,
      },
      { transaction },
    );
    for (const line of lines) {
      await OrderItem.create(
        {
          id: newId(),
          orderId: replacement.id,
          variantId: line.variant.id,
          productName: line.translation?.name || line.variant.product.slug,
          variantTitle: line.variant.title,
          sku: line.variant.sku,
          attributes: line.variant.attributes,
          regularPrice: moneyString(line.variant.regularPrice),
          salePrice: isSaleActive(line.variant)
            ? moneyString(line.variant.salePrice)
            : null,
          unitPrice: moneyString(line.unitPrice),
          unitCost: line.variant.costPrice,
          discountTotal: "0.00",
          taxTotal: "0.00",
          quantity: line.quantity,
          fulfilledQuantity: 0,
          returnedQuantity: 0,
          lineTotal: moneyString(line.total),
        },
        { transaction },
      );
    }
    for (const address of row.order.addresses) {
      await OrderAddress.create(
        {
          id: newId(),
          orderId: replacement.id,
          type: address.type,
          recipientName: address.recipientName,
          phone: address.phone,
          addressLine: address.addressLine,
          area: address.area,
          district: address.district,
          division: address.division,
          postcode: address.postcode,
          landmark: address.landmark,
          deliveryCode: "exchange_replacement",
          snapshot: address.snapshot,
        },
        { transaction },
      );
    }
    if (!shippingAddress)
      throw AppError.conflict(
        "ORDER_ADDRESS_MISSING",
        "The original order has no shipping address snapshot.",
      );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: replacement.id,
        actorId,
        type: "exchange_draft_created",
        message: `Replacement draft created from ${row.reference}.`,
        public: false,
        metadata: { returnId: row.id, originalOrderId: row.orderId },
      },
      { transaction },
    );
    row.replacementOrderId = replacement.id;
    row.version += 1;
    await row.save({ transaction });
    await ReturnEvent.create(
      {
        id: newId(),
        returnId: row.id,
        actorId,
        type: "exchange_draft_created",
        message: "A replacement order draft was prepared.",
        public: true,
        metadata: {
          replacementOrderId: replacement.id,
          amountDue: moneyString(amountDue),
          refundDue: moneyString(refundDue),
        },
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "return.exchange_draft_create",
      resourceType: "return",
      resourceId: row.id,
      after: {
        replacementOrderId: replacement.id,
        replacementReference: replacement.reference,
        credit: moneyString(credit),
        amountDue: moneyString(amountDue),
        refundDue: moneyString(refundDue),
      },
      request,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function completeReturn(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, {
      include: [
        { model: Order, as: "order" },
        {
          model: ReturnItem,
          as: "items",
          include: [{ model: OrderItem, as: "orderItem" }],
        },
        { model: Refund, as: "refund", required: false },
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Return request not found.");
    assertVersion(row, payload.version);
    if (row.status !== "received")
      throw AppError.conflict(
        "INVALID_RETURN_TRANSITION",
        "Only a received return can be completed.",
      );
    if (
      row.items.some(
        (item: RuntimeValue) => !item.condition || item.restock == null,
      )
    )
      throw AppError.conflict(
        "INSPECTION_REQUIRED",
        "Record condition and restock decisions for every item first.",
      );
    if (
      row.resolution === "refund" &&
      (!row.refund || row.refund.status !== "completed")
    )
      throw AppError.conflict(
        "REFUND_REQUIRED",
        "Complete the linked refund before completing this return.",
      );
    if (row.resolution === "exchange" && !row.replacementOrderId)
      throw AppError.conflict(
        "REPLACEMENT_ORDER_REQUIRED",
        "Create the linked replacement order draft before completing this exchange.",
      );
    const allOrderItems: RuntimeValue = await OrderItem.findAll({
      where: { orderId: row.orderId },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const byId = new Map(
      allOrderItems.map((item: RuntimeValue) => [item.id, item]),
    );
    for (const returnItem of row.items) {
      const orderItem: RuntimeValue = byId.get(returnItem.orderItemId);
      const next =
        Number(orderItem.returnedQuantity) + Number(returnItem.quantity);
      if (next > Number(orderItem.fulfilledQuantity))
        throw AppError.conflict(
          "RETURN_QUANTITY_EXCEEDED",
          "Completing this request would exceed the fulfilled quantity.",
        );
      orderItem.returnedQuantity = next;
      await orderItem.save({ transaction });
    }
    const fulfilled: RuntimeValue = allOrderItems.reduce(
      (sum: RuntimeValue, item: RuntimeValue) =>
        sum + Number(item.fulfilledQuantity),
      0,
    );
    const returned: RuntimeValue = allOrderItems.reduce(
      (sum: RuntimeValue, item: RuntimeValue) =>
        sum + Number(item.returnedQuantity),
      0,
    );
    const before: RuntimeValue = {
      status: row.status,
      fulfillmentStatus: row.order.fulfillmentStatus,
      version: Number(row.version),
    };
    row.status = "completed";
    row.completedAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    row.order.fulfillmentStatus =
      fulfilled > 0 && returned >= fulfilled
        ? "returned"
        : "partially_returned";
    row.order.version += 1;
    await row.order.save({ transaction });
    await ReturnEvent.create(
      {
        id: newId(),
        returnId: row.id,
        actorId,
        type: "completed",
        message:
          payload.message ||
          `${row.type === "exchange" ? "Exchange" : "Return"} completed.`,
        public: true,
        metadata: {
          refundId: row.refund?.id || null,
          replacementOrderId: row.replacementOrderId || null,
        },
      },
      { transaction },
    );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: row.orderId,
        actorId,
        type: "return_completed",
        fromStatus: before.fulfillmentStatus,
        toStatus: row.order.fulfillmentStatus,
        message: `${row.reference} completed.`,
        public: true,
        metadata: { returnId: row.id },
      },
      { transaction },
    );
    await addDomainEvent({
      topic: "return.completed",
      aggregateType: "return",
      aggregateId: row.id,
      payload: {
        returnId: row.id,
        orderId: row.orderId,
        resolution: row.resolution,
        refundId: row.refund?.id || null,
        replacementOrderId: row.replacementOrderId || null,
      },
      transaction,
    });
    await queueNotification({
      event: "return.completed",
      channel: row.order.customerEmail ? "email" : "sms",
      locale: row.order.locale,
      recipient: row.order.customerEmail || row.order.customerPhone,
      payload: {
        message:
          payload.message ||
          `${row.type === "exchange" ? "Exchange" : "Return"} ${row.reference} was completed.`,
        returnReference: row.reference,
        orderReference: row.order.reference,
      },
      transaction,
    });
    await recordAudit({
      actorId,
      action: "return.complete",
      resourceType: "return",
      resourceId: row.id,
      before,
      after: {
        status: row.status,
        fulfillmentStatus: row.order.fulfillmentStatus,
        version: row.version,
      },
      request,
      transaction,
    });
    return detailWithinTransaction(row.id, transaction);
  });
}

export async function addReturnEvent(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ReturnRequest.findByPk(id, { transaction });
    if (!row) throw AppError.notFound("Return request not found.");
    const event: RuntimeValue = await ReturnEvent.create(
      {
        id: newId(),
        returnId: row.id,
        actorId,
        type: payload.type,
        message: payload.message,
        public: payload.public,
        metadata: payload.metadata || null,
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "return.event_add",
      resourceType: "return",
      resourceId: row.id,
      metadata: { eventId: event.id, type: event.type, public: event.public },
      request,
      transaction,
    });
    return {
      id: event.id,
      type: event.type,
      message: event.message,
      public: event.public,
      metadata: event.metadata,
      createdAt: event.createdAt,
    };
  });
}
