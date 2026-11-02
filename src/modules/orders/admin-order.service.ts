import { col, Op } from "sequelize";
import {
  CouponUsage,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  OrderConfirmation,
  IdempotencyRecord,
  Order,
  OrderAddress,
  OrderEvent,
  OrderItem,
  OrderNote,
  Payment,
  PaymentAttempt,
  Product,
  ProductTranslation,
  ProductVariant,
  Shipment,
  ShippingMethod,
  User,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { orderReference } from "../../lib/ids.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { money, moneyString } from "../../lib/money.js";
import { dateRangeWhere } from "../../lib/date-range.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { queueLowStockAlert } from "../notifications/staff-notification.service.js";
import { crossedLowStock } from "../notifications/staff-notification.rules.js";
import { orderDto, releaseOrderReservations } from "./order.service.js";

const detailInclude: RuntimeValue = [
  { model: OrderItem, as: "items" },
  { model: OrderAddress, as: "addresses" },
  {
    model: OrderEvent,
    as: "events",
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
  },
  {
    model: OrderNote,
    as: "notes",
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
  },
  {
    model: Payment,
    as: "payments",
    include: [{ model: PaymentAttempt, as: "attempts" }],
  },
  { model: Shipment, as: "shipments" },
  {
    model: OrderConfirmation,
    as: "confirmations",
    include: [{ model: User, as: "actor", attributes: ["id", "name"] }],
  },
];

function effectiveVariantPrice(
  variant: RuntimeValue,
  now: RuntimeValue = new Date(),
) {
  const saleIsCurrent =
    variant.salePrice != null &&
    (!variant.saleStartsAt || variant.saleStartsAt <= now) &&
    (!variant.saleEndsAt || variant.saleEndsAt > now) &&
    money(variant.salePrice).lessThan(variant.regularPrice);
  return saleIsCurrent ? money(variant.salePrice) : money(variant.regularPrice);
}

async function reserveManualOrderLines(
  order: RuntimeValue,
  lines: RuntimeValue,
  actorId: RuntimeValue,
  correlationKey: RuntimeValue,
  transaction: RuntimeValue,
) {
  const now = new Date();
  for (const line of lines) {
    let needed = line.quantity;
    const levels: RuntimeValue = await InventoryLevel.findAll({
      where: { variantId: line.variant.id },
      order: [["locationId", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const level of levels) {
      const available = Number(level.onHand) - Number(level.reserved);
      const quantity: RuntimeValue = Math.min(needed, Math.max(0, available));
      if (!quantity) continue;
      await level.update(
        {
          reserved: Number(level.reserved) + quantity,
          version: Number(level.version) + 1,
        },
        { transaction },
      );
      if (
        crossedLowStock(
          available,
          available - quantity,
          Number(level.lowStockThreshold),
        )
      )
        await queueLowStockAlert({
          variantId: line.variant.id,
          sku: line.variant.sku,
          available: available - quantity,
          threshold: Number(level.lowStockThreshold),
          transaction,
        });
      await InventoryReservation.create(
        {
          id: newId(),
          variantId: line.variant.id,
          locationId: level.locationId,
          orderId: order.id,
          quantity,
          status: "converted",
          expiresAt: new Date(Date.now() + 365 * 86400000),
          convertedAt: now,
          idempotencyKey: correlationKey,
        },
        { transaction },
      );
      await InventoryMovement.create(
        {
          id: newId(),
          variantId: line.variant.id,
          locationId: level.locationId,
          orderId: order.id,
          actorId,
          quantityDelta: 0,
          reservedDelta: quantity,
          onHandBefore: Number(level.onHand),
          balanceAfter: Number(level.onHand),
          reservedAfter: Number(level.reserved),
          reason: "manual_order_reserved",
          correlationId: correlationKey,
        },
        { transaction },
      );
      needed -= quantity;
      if (!needed) break;
    }
    if (needed && line.variant.stockPolicy === "deny")
      throw AppError.unprocessable(
        "INSUFFICIENT_STOCK",
        `Insufficient stock for ${line.variant.sku}.`,
      );
  }
}

/** Reserves stock for a draft (manual or exchange replacement) being placed. */
async function reserveDraftOrderInventory(
  order: RuntimeValue,
  actorId: RuntimeValue,
  transaction: RuntimeValue,
) {
  const items: RuntimeValue = await OrderItem.findAll({
    where: { orderId: order.id },
    order: [["variantId", "ASC"]],
    transaction,
  });
  const variants: RuntimeValue = await ProductVariant.findAll({
    where: {
      id: {
        [Op.in]: [
          ...new Set(items.map((item: RuntimeValue) => item.variantId)),
        ],
      },
    },
    order: [["id", "ASC"]],
    paranoid: false,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const byId = new Map(
    variants.map((variant: RuntimeValue) => [variant.id, variant]),
  );
  const lines: RuntimeValue = items.map((item: RuntimeValue) => {
    const variant: RuntimeValue = byId.get(item.variantId);
    if (!variant)
      throw AppError.unprocessable(
        "INVALID_VARIANT",
        "One or more order variants no longer exist.",
      );
    return { variant, quantity: Number(item.quantity) };
  });
  await reserveManualOrderLines(
    order,
    lines,
    actorId,
    `place:${order.id}`,
    transaction,
  );
}

export async function createManualOrder(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  permissions: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue,
) {
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  const requestHash: RuntimeValue = sha256(canonicalJson(payload));
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const [record]: RuntimeValue = await IdempotencyRecord.findOrCreate({
      where: {
        scope: "admin.orders.create",
        key: idempotencyKey,
        actorKey: actorId,
      },
      defaults: {
        id: newId(),
        scope: "admin.orders.create",
        key: idempotencyKey,
        actorKey: actorId,
        requestHash,
        expiresAt: new Date(Date.now() + 365 * 86400000),
      },
      transaction,
    });
    await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (record.requestHash !== requestHash)
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This key was already used for a different manual order.",
      );
    if (record.responseBody?.orderId)
      return getAdminOrderWithinTransaction(
        record.responseBody.orderId,
        transaction,
      );
    const phone: RuntimeValue = normalizePhone(payload.customer.phone);
    const email: RuntimeValue = normalizeEmail(payload.customer.email);
    if (!phone)
      throw AppError.unprocessable(
        "INVALID_PHONE",
        "Enter a valid Bangladeshi customer phone number.",
      );
    const variantIds: RuntimeValue = [
      ...new Set(payload.items.map((item: RuntimeValue) => item.variantId)),
    ].sort();
    if (variantIds.length !== payload.items.length)
      throw AppError.unprocessable(
        "DUPLICATE_VARIANT",
        "Combine duplicate variants into one line.",
      );
    const variants: RuntimeValue = await ProductVariant.findAll({
      where: { id: { [Op.in]: variantIds }, status: "active", active: true },
      include: [
        {
          model: Product,
          as: "product",
          required: true,
          include: [{ model: ProductTranslation, as: "translations" }],
        },
      ],
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (variants.length !== variantIds.length)
      throw AppError.unprocessable(
        "INVALID_VARIANT",
        "One or more variants are unavailable.",
      );
    const byId = new Map(
      variants.map((variant: RuntimeValue) => [variant.id, variant]),
    );
    const now = new Date();
    let subtotal: RuntimeValue = money(0);
    const lines: RuntimeValue = [];
    for (const requested of payload.items) {
      const variant: RuntimeValue = byId.get(requested.variantId);
      const standard: RuntimeValue = effectiveVariantPrice(variant, now);
      const selected: RuntimeValue =
        requested.unitPrice == null ? standard : money(requested.unitPrice);
      if (
        !selected.equals(standard) &&
        !permissions.has("orders.override_price")
      )
        throw AppError.forbidden("Price override permission is required.");
      if (!selected.equals(standard) && !payload.overrideReason)
        throw AppError.unprocessable(
          "OVERRIDE_REASON_REQUIRED",
          "A reason is required for price overrides.",
        );
      const total: RuntimeValue = selected.times(requested.quantity);
      subtotal = subtotal.plus(total);
      lines.push({
        variant,
        quantity: requested.quantity,
        unitPrice: selected,
        lineTotal: total,
      });
    }
    const discount: RuntimeValue = money(payload.manualDiscount || 0);
    if (discount.isNegative() || discount.greaterThan(subtotal))
      throw AppError.unprocessable(
        "INVALID_MANUAL_DISCOUNT",
        "Manual discount cannot exceed the item subtotal.",
      );
    if (discount.isPositive() && !payload.discountReason)
      throw AppError.unprocessable(
        "DISCOUNT_REASON_REQUIRED",
        "A reason is required for a manual discount.",
      );
    const method: RuntimeValue = await ShippingMethod.findOne({
      where: { code: payload.deliveryCode, active: true },
      transaction,
    });
    if (!method)
      throw AppError.unprocessable(
        "INVALID_DELIVERY_METHOD",
        "Choose an active delivery method.",
      );
    const delivery: RuntimeValue =
      method.freeThreshold != null &&
      subtotal.minus(discount).greaterThanOrEqualTo(method.freeThreshold)
        ? money(0)
        : money(method.flatRate);
    const grand: RuntimeValue = subtotal.minus(discount).plus(delivery);
    const customer: RuntimeValue = payload.customerId
      ? await User.findByPk(payload.customerId, { transaction })
      : null;
    if (payload.customerId && !customer)
      throw AppError.unprocessable(
        "INVALID_CUSTOMER",
        "Customer account not found.",
      );
    const order: RuntimeValue = await Order.create(
      {
        id: newId(),
        userId: customer?.id || null,
        reference: orderReference(),
        source: "admin",
        channel: payload.channel || "phone",
        tags: payload.tags?.length ? payload.tags : null,
        orderStatus: payload.status,
        paymentStatus: payload.status === "draft" ? "unpaid" : "unpaid",
        fulfillmentStatus: "unfulfilled",
        paymentMethod: "cod",
        customerName: payload.customer.name,
        customerPhone: phone,
        customerEmail: email,
        address: [
          payload.address.addressLine,
          payload.address.area,
          payload.address.district,
          payload.address.division,
          payload.address.postcode,
        ]
          .filter(Boolean)
          .join(", "),
        deliveryCode: method.code,
        deliveryLabel:
          payload.locale === "bn" ? method.labelBn : method.labelEn,
        subtotal: moneyString(subtotal),
        discountTotal: moneyString(discount),
        deliveryTotal: moneyString(delivery),
        taxTotal: "0.00",
        grandTotal: moneyString(grand),
        currency: "BDT",
        locale: payload.locale,
        note: payload.note || null,
        placedAt: payload.status === "placed" ? now : null,
        metadata: {
          manual: true,
          overrideReason: payload.overrideReason || null,
          discountReason: payload.discountReason || null,
        },
        version: 1,
      },
      { transaction },
    );
    const lineDiscounts: RuntimeValue = [];
    let allocated: RuntimeValue = money(0);
    for (const [index, line] of lines.entries()) {
      const lineDiscount: RuntimeValue =
        index === lines.length - 1
          ? discount.minus(allocated)
          : discount.times(line.lineTotal).div(subtotal).toDecimalPlaces(2);
      allocated = allocated.plus(lineDiscount);
      lineDiscounts.push(lineDiscount);
      const translation =
        line.variant.product.translations?.find(
          (item: RuntimeValue) => item.locale === payload.locale,
        ) ||
        line.variant.product.translations?.find(
          (item: RuntimeValue) => item.locale === "en",
        );
      await OrderItem.create(
        {
          id: newId(),
          orderId: order.id,
          variantId: line.variant.id,
          productName: translation?.name || line.variant.product.slug,
          variantTitle: line.variant.title,
          sku: line.variant.sku,
          attributes: line.variant.attributes,
          regularPrice: moneyString(line.variant.regularPrice),
          salePrice:
            line.variant.salePrice == null
              ? null
              : moneyString(line.variant.salePrice),
          unitPrice: moneyString(line.unitPrice),
          unitCost: line.variant.costPrice,
          discountTotal: moneyString(lineDiscount),
          taxTotal: "0.00",
          quantity: line.quantity,
          fulfilledQuantity: 0,
          returnedQuantity: 0,
          lineTotal: moneyString(line.lineTotal.minus(lineDiscount)),
        },
        { transaction },
      );
    }
    for (const type of ["shipping", "billing"])
      await OrderAddress.create(
        {
          id: newId(),
          orderId: order.id,
          type,
          recipientName: payload.customer.name,
          phone,
          addressLine: payload.address.addressLine,
          area: payload.address.area || null,
          district: payload.address.district || null,
          division: payload.address.division || null,
          postcode: payload.address.postcode || null,
          landmark: payload.address.landmark || null,
          deliveryCode: method.code,
          snapshot: payload.address,
        },
        { transaction },
      );
    await Payment.create(
      {
        id: newId(),
        orderId: order.id,
        method: "cod",
        provider: "manual",
        amount: moneyString(grand),
        currency: "BDT",
        status: "unpaid",
        version: 1,
        metadata: { createdBy: actorId },
      },
      { transaction },
    );
    if (payload.status === "placed")
      await reserveManualOrderLines(
        order,
        lines,
        actorId,
        idempotencyKey,
        transaction,
      );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: order.id,
        actorId,
        type: "manual_order_created",
        toStatus: order.orderStatus,
        message:
          payload.status === "placed"
            ? "Order placed by staff."
            : "Draft order created by staff.",
        public: payload.status === "placed",
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "order.manual_create",
      resourceType: "order",
      resourceId: order.id,
      after: {
        reference: order.reference,
        status: order.orderStatus,
        total: moneyString(grand),
      },
      metadata: {
        overrideReason: payload.overrideReason || null,
        discountReason: payload.discountReason || null,
        idempotencyKey,
      },
      request,
      transaction,
    });
    record.responseStatus = 201;
    record.responseBody = { orderId: order.id };
    await record.save({ transaction });
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

export async function listAdminOrders(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.orderStatus) where.orderStatus = query.orderStatus;
  if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
  if (query.fulfillmentStatus)
    where.fulfillmentStatus = query.fulfillmentStatus;
  if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
  if (query.source) where.source = query.source;
  if (query.channel) where.channel = query.channel;
  if (query.confirmationStatus)
    where.confirmationStatus = query.confirmationStatus;
  if (query.riskLevel) where.riskLevel = query.riskLevel;
  if (typeof query.tag === "string" && /^[a-z0-9-]{1,40}$/.test(query.tag))
    where[Op.and] = [
      sequelize.where(
        sequelize.fn(
          "JSON_CONTAINS",
          sequelize.col("tags"),
          JSON.stringify(query.tag),
        ),
        1,
      ),
    ];
  if (query.deliveryCode) where.deliveryCode = query.deliveryCode;
  Object.assign(where, dateRangeWhere(query));
  if (query.search)
    where[Op.or] = [
      { reference: { [Op.like]: likeContains(query.search, 80) } },
      {
        customerPhone: { [Op.like]: likeContains(query.search, 30) },
      },
      {
        customerEmail: { [Op.like]: likeContains(query.search, 100) },
      },
      {
        customerName: { [Op.like]: likeContains(query.search, 100) },
      },
    ];
  const result: RuntimeValue = await Order.findAndCountAll({
    where,
    include: [{ model: Payment, as: "payments" }],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((order: RuntimeValue) => orderDto(order, true)),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getAdminOrder(id: RuntimeValue) {
  const order: RuntimeValue = await Order.findByPk(id, {
    include: detailInclude,
    order: [
      [{ model: OrderEvent, as: "events" }, "createdAt", "ASC"],
      [{ model: OrderNote, as: "notes" }, "createdAt", "ASC"],
    ],
  });
  if (!order) throw AppError.notFound("Order not found.");
  return {
    ...orderDto(order, true),
    notes: order.notes.map((note: RuntimeValue) => ({
      id: note.id,
      visibility: note.visibility,
      message: note.message,
      actor: note.actor,
      createdAt: note.createdAt,
    })),
    shipments: order.shipments,
    confirmations: (order.confirmations || []).map((row: RuntimeValue) => ({
      id: row.id,
      method: row.method,
      outcome: row.outcome,
      note: row.note,
      callbackAt: row.callbackAt,
      actor: row.actor,
      createdAt: row.createdAt,
    })),
    metadata: adminMetadata(order.metadata),
  };
}

/** Order metadata without secrets such as the confirmation link hash. */
function adminMetadata(metadata: RuntimeValue) {
  if (!metadata) return metadata;
  const { confirmationLink, ...rest } = metadata;
  return {
    ...rest,
    confirmationLinkIssued: Boolean(confirmationLink),
  };
}

// pending_payment -> placed happens only through verified payment
// finalization; a manual jump would place an unpaid order whose stock
// reservations are still expiring.
const orderTransitions: RuntimeValue = {
  draft: ["placed", "cancelled"],
  pending_payment: ["failed", "cancelled"],
  placed: ["confirmed", "processing", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};
const fulfillmentTransitions: RuntimeValue = {
  unfulfilled: ["processing", "packed"],
  processing: ["packed"],
  packed: ["shipped"],
  shipped: ["out_for_delivery", "delivered", "returned_to_origin"],
  out_for_delivery: ["delivered", "returned_to_origin"],
  returned_to_origin: [],
  delivered: ["partially_returned", "returned"],
  partially_returned: ["returned"],
  returned: [],
};

async function consumeReservations(
  order: RuntimeValue,
  actorId: RuntimeValue,
  transaction: RuntimeValue,
) {
  if (
    order.metadata?.backorders?.some((item: RuntimeValue) => item.quantity > 0)
  )
    throw AppError.conflict(
      "BACKORDER_ALLOCATION_REQUIRED",
      "Allocate all backordered quantities before packing this order.",
    );
  const reservations: RuntimeValue = await InventoryReservation.findAll({
    where: { orderId: order.id, status: "converted" },
    order: [
      ["variantId", "ASC"],
      ["locationId", "ASC"],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const reservation of reservations) {
    const level: RuntimeValue = await InventoryLevel.findOne({
      where: {
        variantId: reservation.variantId,
        locationId: reservation.locationId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !level ||
      Number(level.onHand) < Number(reservation.quantity) ||
      Number(level.reserved) < Number(reservation.quantity)
    )
      throw AppError.conflict(
        "INVENTORY_RESERVATION_INVALID",
        "Reserved inventory no longer matches the order. Reconcile it before packing.",
      );
    const before: RuntimeValue = Number(level.onHand);
    level.onHand = before - Number(reservation.quantity);
    level.reserved = Number(level.reserved) - Number(reservation.quantity);
    level.version += 1;
    await level.save({ transaction });
    reservation.status = "consumed";
    reservation.consumedAt = new Date();
    await reservation.save({ transaction });
    await InventoryMovement.create(
      {
        id: newId(),
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        orderId: order.id,
        actorId,
        quantityDelta: -Number(reservation.quantity),
        reservedDelta: -Number(reservation.quantity),
        onHandBefore: before,
        balanceAfter: Number(level.onHand),
        reservedAfter: Number(level.reserved),
        reason: "order_fulfilled",
        correlationId: `fulfillment:${order.id}`,
      },
      { transaction },
    );
  }
  await OrderItem.update(
    { fulfilledQuantity: col("quantity") },
    { where: { orderId: order.id }, transaction },
  );
}

/**
 * A parcel the courier brought back (refused/unreachable) returns its stock
 * and closes the order. Items were consumed at packing, so on-hand goes back
 * up at the same locations with an RTO ledger entry.
 */
async function restockReturnedToOrigin(
  order: RuntimeValue,
  actorId: RuntimeValue,
  reason: RuntimeValue,
  transaction: RuntimeValue,
) {
  const reservations: RuntimeValue = await InventoryReservation.findAll({
    where: { orderId: order.id, status: "consumed" },
    order: [
      ["variantId", "ASC"],
      ["locationId", "ASC"],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const reservation of reservations) {
    const level: RuntimeValue = await InventoryLevel.findOne({
      where: {
        variantId: reservation.variantId,
        locationId: reservation.locationId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!level) continue;
    const before = Number(level.onHand);
    level.onHand = before + Number(reservation.quantity);
    level.version += 1;
    await level.save({ transaction });
    await InventoryMovement.create(
      {
        id: newId(),
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        orderId: order.id,
        actorId,
        quantityDelta: Number(reservation.quantity),
        reservedDelta: 0,
        onHandBefore: before,
        balanceAfter: Number(level.onHand),
        reservedAfter: Number(level.reserved),
        reason: "return_to_origin_restock",
        correlationId: `rto:${order.id}`,
      },
      { transaction },
    );
  }
  await OrderItem.update(
    { returnedQuantity: col("quantity") },
    { where: { orderId: order.id }, transaction },
  );
  await CouponUsage.update(
    { status: "reversed" },
    { where: { orderId: order.id, status: "consumed" }, transaction },
  );
  await Payment.update(
    { status: "cancelled", cancelledAt: new Date() },
    { where: { orderId: order.id, status: "unpaid" }, transaction },
  );
  if (order.paymentStatus === "unpaid") order.paymentStatus = "cancelled";
  order.orderStatus = "cancelled";
  order.cancellationReason = `Returned to origin: ${String(reason).slice(0, 220)}`;
  order.cancelledAt = new Date();
}

export async function transitionOrder(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    if (Number(payload.version) !== Number(order.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This order changed. Refresh and review the latest state.",
      );
    const before: RuntimeValue = {
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      version: order.version,
    };
    if (payload.dimension === "order") {
      if (!orderTransitions[order.orderStatus]?.includes(payload.status))
        throw AppError.conflict(
          "INVALID_ORDER_TRANSITION",
          `Order cannot move from ${order.orderStatus} to ${payload.status}.`,
        );
      if (
        payload.status === "completed" &&
        (order.fulfillmentStatus !== "delivered" ||
          order.paymentStatus !== "paid")
      )
        throw AppError.conflict(
          "ORDER_NOT_COMPLETABLE",
          "An order can complete only after delivery and payment.",
        );
      if (payload.status === "cancelled")
        throw AppError.unprocessable(
          "USE_CANCEL_ACTION",
          "Use the cancel action so inventory and promotions are reversed safely.",
        );
      if (payload.status === "confirmed") {
        if (!["not_required", "confirmed"].includes(order.confirmationStatus))
          await OrderConfirmation.create(
            {
              id: newId(),
              orderId: order.id,
              actorId,
              method: "manual",
              outcome: "confirmed",
              note: payload.reason,
            },
            { transaction },
          );
        order.confirmationStatus = "confirmed";
        order.confirmedAt = new Date();
        order.nextConfirmationAt = null;
      }
      if (order.orderStatus === "draft" && payload.status === "placed") {
        await reserveDraftOrderInventory(order, actorId, transaction);
        order.placedAt = new Date();
      }
      if (
        order.orderStatus === "pending_payment" &&
        payload.status === "failed"
      ) {
        await releaseOrderReservations(
          order.id,
          "payment_failed",
          transaction,
          actorId,
          ["active"],
        );
        await CouponUsage.update(
          { status: "released" },
          { where: { orderId: order.id, status: "reserved" }, transaction },
        );
        await Payment.update(
          { status: "failed", failedAt: new Date() },
          { where: { orderId: order.id, status: "pending" }, transaction },
        );
        order.paymentStatus = "failed";
      }
      order.orderStatus = payload.status;
      if (payload.status === "completed") order.completedAt = new Date();
    } else {
      // Fulfilment may only progress on a live order (not a draft, unpaid
      // bKash, cancelled or failed one); return states also apply after
      // completion.
      if (
        !["placed", "confirmed", "processing"].includes(order.orderStatus) &&
        !(
          order.orderStatus === "completed" &&
          ["partially_returned", "returned"].includes(payload.status)
        )
      )
        throw AppError.conflict(
          "INVALID_FULFILLMENT_TRANSITION",
          `Fulfillment cannot change while the order is ${order.orderStatus}.`,
        );
      if (
        !fulfillmentTransitions[order.fulfillmentStatus]?.includes(
          payload.status,
        )
      )
        throw AppError.conflict(
          "INVALID_FULFILLMENT_TRANSITION",
          `Fulfillment cannot move from ${order.fulfillmentStatus} to ${payload.status}.`,
        );
      if (
        ["pending", "no_answer", "call_back", "wrong_number"].includes(
          order.confirmationStatus,
        ) &&
        ["processing", "packed"].includes(payload.status)
      )
        throw AppError.conflict(
          "ORDER_NOT_CONFIRMED",
          "Confirm this order with the customer before packing it.",
        );
      if (payload.status === "packed")
        await consumeReservations(order, actorId, transaction);
      if (payload.status === "returned_to_origin")
        await restockReturnedToOrigin(
          order,
          actorId,
          payload.reason,
          transaction,
        );
      order.fulfillmentStatus = payload.status;
      if (
        ["processing", "packed", "shipped", "out_for_delivery"].includes(
          payload.status,
        ) &&
        ["placed", "confirmed"].includes(order.orderStatus)
      )
        order.orderStatus = "processing";
      if (payload.status === "delivered" && order.paymentStatus === "paid") {
        order.orderStatus = "completed";
        order.completedAt = new Date();
      }
    }
    order.version += 1;
    await order.save({ transaction });
    await OrderEvent.create(
      {
        id: newId(),
        orderId: order.id,
        actorId,
        type: `${payload.dimension}_transition`,
        fromStatus:
          payload.dimension === "order"
            ? before.orderStatus
            : before.fulfillmentStatus,
        toStatus: payload.status,
        message: payload.message || `Status updated to ${payload.status}.`,
        public: payload.public,
      },
      { transaction },
    );
    await addDomainEvent({
      topic: `order.${payload.status}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        reference: order.reference,
        dimension: payload.dimension,
        status: payload.status,
      },
      transaction,
    });
    if (payload.public)
      await queueNotification({
        event: `order.${payload.status}`,
        channel: order.customerEmail ? "email" : "sms",
        locale: order.locale,
        recipient: order.customerEmail || order.customerPhone,
        payload: {
          message:
            payload.message ||
            `Order ${order.reference} is now ${payload.status}.`,
          orderReference: order.reference,
        },
        transaction,
      });
    await recordAudit({
      actorId,
      action: "order.transition",
      resourceType: "order",
      resourceId: order.id,
      before,
      after: {
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        version: order.version,
      },
      metadata: { reason: payload.reason },
      request,
      transaction,
    });
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

async function getAdminOrderWithinTransaction(
  id: RuntimeValue,
  transaction: RuntimeValue,
) {
  const order: RuntimeValue = await Order.findByPk(id, {
    include: detailInclude,
    transaction,
  });
  return {
    ...orderDto(order, true),
    notes: order.notes.map((note: RuntimeValue) => ({
      id: note.id,
      visibility: note.visibility,
      message: note.message,
      actor: note.actor,
      createdAt: note.createdAt,
    })),
    shipments: order.shipments,
    confirmations: (order.confirmations || []).map((row: RuntimeValue) => ({
      id: row.id,
      method: row.method,
      outcome: row.outcome,
      note: row.note,
      callbackAt: row.callbackAt,
      actor: row.actor,
      createdAt: row.createdAt,
    })),
    metadata: adminMetadata(order.metadata),
  };
}

export async function cancelAdminOrder(
  id: RuntimeValue,
  reason: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    await cancelLockedOrder(order, reason, actorId, request, transaction);
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

/**
 * Cancels an order row already locked by the caller's transaction: releases
 * stock and coupon usage exactly once and records the event and audit.
 */
export async function cancelLockedOrder(
  order: RuntimeValue,
  reason: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  transaction: RuntimeValue,
  message: string = "Order cancelled by staff.",
) {
  if (
    ["completed", "cancelled"].includes(order.orderStatus) ||
    ["delivered", "returned"].includes(order.fulfillmentStatus)
  )
    throw AppError.conflict(
      "INVALID_ORDER_TRANSITION",
      "This order cannot be cancelled.",
    );
  if (["paid", "partially_refunded"].includes(order.paymentStatus))
    throw AppError.conflict(
      "REFUND_REQUIRED",
      "Create the required refund before cancelling this paid order.",
    );
  const before: RuntimeValue = {
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
  };
  await releaseOrderReservations(
    order.id,
    "admin_order_cancelled",
    transaction,
    actorId,
    ["active", "converted"],
  );
  await CouponUsage.update(
    { status: "reversed" },
    {
      where: {
        orderId: order.id,
        status: { [Op.in]: ["reserved", "consumed"] },
      },
      transaction,
    },
  );
  order.orderStatus = "cancelled";
  // Keep a completed refund visible; only open payments become cancelled.
  if (["unpaid", "pending"].includes(order.paymentStatus))
    order.paymentStatus = "cancelled";
  order.cancellationReason = reason;
  order.cancelledAt = new Date();
  order.version += 1;
  await order.save({ transaction });
  await Payment.update(
    { status: "cancelled", cancelledAt: new Date() },
    {
      where: {
        orderId: order.id,
        status: { [Op.in]: ["unpaid", "pending"] },
      },
      transaction,
    },
  );
  await OrderEvent.create(
    {
      id: newId(),
      orderId: order.id,
      actorId,
      type: "order_cancelled",
      fromStatus: before.orderStatus,
      toStatus: "cancelled",
      message,
      public: true,
      metadata: { reason },
    },
    { transaction },
  );
  await addDomainEvent({
    topic: "order.cancelled",
    aggregateType: "order",
    aggregateId: order.id,
    payload: { orderId: order.id, reference: order.reference, reason },
    transaction,
  });
  await recordAudit({
    actorId,
    action: "order.admin_cancel",
    resourceType: "order",
    resourceId: order.id,
    before,
    after: { orderStatus: "cancelled", paymentStatus: order.paymentStatus },
    metadata: { reason },
    request,
    transaction,
  });
}

export async function addOrderNote(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(id, { transaction });
    if (!order) throw AppError.notFound("Order not found.");
    const note: RuntimeValue = await OrderNote.create(
      {
        id: newId(),
        orderId: id,
        actorId,
        visibility: payload.visibility,
        message: payload.message,
      },
      { transaction },
    );
    if (payload.visibility === "customer")
      await OrderEvent.create(
        {
          id: newId(),
          orderId: id,
          actorId,
          type: "customer_note",
          // order_events.message is VARCHAR(255); the full text is in the note.
          message: payload.message.slice(0, 255),
          public: true,
        },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: "order.note_add",
      resourceType: "order",
      resourceId: id,
      metadata: { noteId: note.id, visibility: payload.visibility },
      request,
      transaction,
    });
    return {
      id: note.id,
      visibility: note.visibility,
      message: note.message,
      createdAt: note.createdAt,
    };
  });
}

export async function listPayments(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.method) where.method = query.method;
  Object.assign(where, dateRangeWhere(query));
  const result: RuntimeValue = await Payment.findAndCountAll({
    where,
    include: [
      {
        model: Order,
        as: "order",
        where: query.search
          ? {
              [Op.or]: [
                {
                  reference: {
                    [Op.like]: likeContains(query.search, 80),
                  },
                },
                {
                  customerPhone: {
                    [Op.like]: likeContains(query.search, 30),
                  },
                },
              ],
            }
          : undefined,
      },
      { model: PaymentAttempt, as: "attempts" },
    ],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map(paymentDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

function paymentDto(payment: RuntimeValue) {
  return {
    id: payment.id,
    order: payment.order
      ? {
          id: payment.order.id,
          reference: payment.order.reference,
          customerName: payment.order.customerName,
          customerPhone: payment.order.customerPhone,
        }
      : null,
    method: payment.method,
    provider: payment.provider,
    amount: moneyString(payment.amount),
    currency: payment.currency,
    status: payment.status,
    transactionId: payment.providerTransactionId,
    reference: payment.reference,
    paidAt: payment.paidAt,
    version: payment.version,
    attempts:
      payment.attempts?.map((attempt: RuntimeValue) => ({
        id: attempt.id,
        providerPaymentId: attempt.providerPaymentId,
        status: attempt.status,
        expiresAt: attempt.expiresAt,
        createdAt: attempt.createdAt,
      })) || [],
    createdAt: payment.createdAt,
  };
}

export async function getPayment(id: RuntimeValue) {
  const payment: RuntimeValue = await Payment.findByPk(id, {
    include: [
      { model: Order, as: "order" },
      { model: PaymentAttempt, as: "attempts" },
    ],
  });
  if (!payment) throw AppError.notFound("Payment not found.");
  return paymentDto(payment);
}

export async function collectCod(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const payment: RuntimeValue = await Payment.findByPk(id, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment || payment.method !== "cod")
      throw AppError.notFound("COD payment not found.");
    if (payment.status === "paid") return paymentDto(payment);
    if (payment.status !== "unpaid")
      throw AppError.conflict(
        "PAYMENT_NOT_COLLECTABLE",
        "This payment cannot be marked as collected.",
      );
    if (!money(payload.amount).equals(payment.amount))
      throw AppError.unprocessable(
        "COLLECTION_AMOUNT_MISMATCH",
        `Collected amount must equal ${moneyString(payment.amount)}.`,
      );
    payment.status = "paid";
    payment.paidAt = payload.collectedAt
      ? new Date(payload.collectedAt)
      : new Date();
    payment.reference = payload.reference || null;
    payment.metadata = {
      ...payment.metadata,
      collectorId: actorId,
      collectionNote: payload.note || null,
    };
    payment.version += 1;
    await payment.save({ transaction });
    payment.order.paymentStatus = "paid";
    if (payment.order.fulfillmentStatus === "delivered") {
      payment.order.orderStatus = "completed";
      payment.order.completedAt = new Date();
    }
    payment.order.version += 1;
    await payment.order.save({ transaction });
    await OrderEvent.create(
      {
        id: newId(),
        orderId: payment.order.id,
        actorId,
        type: "cod_collected",
        message: "Cash on delivery payment collected.",
        public: true,
        metadata: { paymentId: payment.id, reference: payment.reference },
      },
      { transaction },
    );
    await addDomainEvent({
      topic: "payment.paid",
      aggregateType: "payment",
      aggregateId: payment.id,
      payload: {
        paymentId: payment.id,
        orderId: payment.order.id,
        amount: moneyString(payment.amount),
        method: "cod",
      },
      transaction,
    });
    await recordAudit({
      actorId,
      action: "payment.cod_collect",
      resourceType: "payment",
      resourceId: payment.id,
      before: { status: "unpaid" },
      after: {
        status: "paid",
        amount: moneyString(payment.amount),
        reference: payment.reference,
      },
      request,
      transaction,
    });
    return paymentDto(payment);
  });
}

export async function updateOrderTags(
  id: string,
  payload: RuntimeValue,
  actorId: string,
  request: RuntimeValue,
) {
  const tags = [
    ...new Set<string>(
      (payload.tags || []).map((tag: string) => tag.trim().toLowerCase()),
    ),
  ].slice(0, 12);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    const before = order.tags || [];
    order.tags = tags.length ? tags : null;
    await order.save({ transaction });
    await recordAudit({
      actorId,
      action: "order.tags_update",
      resourceType: "order",
      resourceId: order.id,
      before: { tags: before },
      after: { tags },
      request,
      transaction,
    });
    return { id: order.id, tags };
  });
}

/** Full order details for packing slips, pick lists and invoices. */
export async function getOrderDocuments(ids: string[]) {
  const orders: RuntimeValue = await Order.findAll({
    where: { id: { [Op.in]: ids } },
    include: [
      { model: OrderItem, as: "items" },
      { model: OrderAddress, as: "addresses" },
      { model: Payment, as: "payments" },
      { model: Shipment, as: "shipments" },
    ],
    order: [["createdAt", "ASC"]],
  });
  return orders.map((order: RuntimeValue) => ({
    ...orderDto(order, true),
    shipments: (order.shipments || []).map((shipment: RuntimeValue) => ({
      courier: shipment.courierName,
      consignmentId: shipment.consignmentId,
      trackingUrl: shipment.trackingUrl,
      status: shipment.status,
    })),
  }));
}
