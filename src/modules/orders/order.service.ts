import { Op } from "sequelize";
import {
  CheckoutQuote,
  Coupon,
  CouponUsage,
  FeatureFlag,
  IdempotencyRecord,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  Order,
  OrderAddress,
  OrderEvent,
  OrderItem,
  Payment,
  ProductVariant,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { env } from "../../config/env.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId, orderReference } from "../../lib/ids.js";
import { lineTotal, money, moneyString } from "../../lib/money.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { recordAudit } from "../audits/audit.service.js";
import { loadCart } from "../cart/cart.service.js";
import { effectivePrice, isSaleActive } from "../catalog/pricing.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { calculatePromotions } from "../promotions/promotion.service.js";
import { resolveShippingMethod } from "../shipping/shipping.service.js";

const orderInclude: RuntimeValue = [
  {
    model: OrderItem,
    as: "items",
    include: [
      {
        model: ProductVariant,
        as: "variant",
        paranoid: false,
        attributes: ["id", "productId"],
      },
    ],
  },
  { model: OrderAddress, as: "addresses" },
  { model: OrderEvent, as: "events" },
  { model: Payment, as: "payments" },
];

function availableQuantity(variant: RuntimeValue) {
  return (variant.inventoryLevels || []).reduce(
    (total: RuntimeValue, level: RuntimeValue) =>
      total + Math.max(0, Number(level.onHand) - Number(level.reserved)),
    0,
  );
}

function normalizeCheckoutPayload(payload: RuntimeValue) {
  const phone: RuntimeValue = normalizePhone(payload.customer.phone);
  const email: RuntimeValue = normalizeEmail(payload.customer.email);
  if (!phone)
    throw AppError.unprocessable(
      "INVALID_PHONE",
      "Enter a valid Bangladeshi phone number.",
      { "customer.phone": ["Enter a valid Bangladeshi phone number."] },
    );
  const addressPhone: RuntimeValue = normalizePhone(
    payload.address.phone || phone,
  );
  if (!addressPhone)
    throw AppError.unprocessable(
      "INVALID_ADDRESS_PHONE",
      "Enter a valid delivery phone number.",
      { "address.phone": ["Enter a valid Bangladeshi phone number."] },
    );
  return {
    customer: { name: payload.customer.name.trim(), phone, email },
    address: {
      ...payload.address,
      recipientName: payload.address.recipientName.trim(),
      phone: addressPhone,
      addressLine: payload.address.addressLine.trim(),
    },
    billingAddress: payload.billingAddress
      ? {
          ...payload.billingAddress,
          phone: normalizePhone(payload.billingAddress.phone) || phone,
        }
      : null,
    deliveryCode: payload.deliveryCode,
    paymentMethod: payload.paymentMethod,
    locale: payload.locale,
    note: payload.note?.trim() || null,
  };
}

async function assertPaymentAvailable(
  paymentMethod: RuntimeValue,
  transaction: RuntimeValue = null,
) {
  if (paymentMethod === "cod") return;
  const flag: RuntimeValue = await FeatureFlag.findOne({
    where: { key: "bkash", enabled: true },
    transaction,
  });
  if (!env.BKASH_ENABLED || !flag || flag.config?.tested !== true)
    throw AppError.unprocessable(
      "PAYMENT_UNAVAILABLE",
      "bKash is not currently available. Choose cash on delivery.",
    );
}

async function calculateCart(
  cart: RuntimeValue,
  payload: RuntimeValue,
  userId: RuntimeValue,
  transaction: RuntimeValue = null,
  strictContext: RuntimeValue = false,
) {
  if (!cart?.items?.length)
    throw AppError.unprocessable("EMPTY_CART", "Your cart is empty.");
  const lines: RuntimeValue = cart.items.map((item: RuntimeValue) => {
    const variant = item.variant;
    const product = variant?.product;
    if (
      !variant ||
      variant.deletedAt ||
      !variant.active ||
      variant.status !== "active" ||
      !product ||
      product.deletedAt ||
      product.status !== "published"
    )
      throw AppError.unprocessable(
        "ITEM_UNAVAILABLE",
        "One or more cart items are no longer available. Review your cart.",
      );
    const available: RuntimeValue = availableQuantity(variant);
    if (variant.stockPolicy === "deny" && item.quantity > available)
      throw AppError.unprocessable(
        "INSUFFICIENT_STOCK",
        `Only ${available} of ${variant.sku} are available.`,
      );
    const unitPrice: RuntimeValue = effectivePrice(variant);
    const translation =
      product.translations.find(
        (value: RuntimeValue) => value.locale === payload.locale,
      ) ||
      product.translations.find((value: RuntimeValue) => value.locale === "en");
    return {
      id: item.id,
      item,
      variant,
      product,
      translation,
      productId: product.id,
      categoryId: product.categoryId,
      quantity: Number(item.quantity),
      unitPrice,
      regularPrice: money(variant.regularPrice),
      salePrice: isSaleActive(variant) ? money(variant.salePrice) : null,
      total: lineTotal(unitPrice, item.quantity),
      onSale: isSaleActive(variant),
      available,
    };
  });
  const subtotal: RuntimeValue = lines.reduce(
    (sum: RuntimeValue, line: RuntimeValue) => sum.plus(line.total),
    money(0),
  );
  const shipping: RuntimeValue = await resolveShippingMethod(
    payload.deliveryCode,
    payload.paymentMethod,
    subtotal,
    payload.locale,
    transaction,
  );
  const promotions: RuntimeValue = await calculatePromotions({
    coupons: cart.coupons || [],
    lines,
    subtotal,
    deliveryTotal: shipping.price,
    userId,
    customerPhone: payload.customer.phone,
    zoneCode: shipping.zoneCode,
    paymentMethod: payload.paymentMethod,
    transaction,
    strictContext,
  });
  const discountTotal: RuntimeValue = money(promotions.discountTotal);
  const deliveryTotal: RuntimeValue = money(shipping.price).minus(
    promotions.deliveryDiscount,
  );
  const taxTotal: RuntimeValue = money(0);
  const grandTotal: RuntimeValue = subtotal
    .minus(promotions.itemDiscountTotal)
    .plus(deliveryTotal)
    .plus(taxTotal);
  return {
    lines,
    shipping,
    promotions,
    subtotal,
    discountTotal,
    deliveryTotal,
    taxTotal,
    grandTotal,
  };
}

function quoteDto(quote: RuntimeValue, calculation: RuntimeValue) {
  return {
    quoteId: quote.id,
    expiresAt: quote.expiresAt,
    customer: quote.payload.customer,
    address: quote.payload.address,
    delivery: {
      code: calculation.shipping.code,
      label: calculation.shipping.label,
      price: moneyString(calculation.deliveryTotal),
      regularPrice: calculation.shipping.regularPrice,
    },
    paymentMethod: quote.payload.paymentMethod,
    coupons: calculation.promotions.coupons,
    totals: {
      subtotal: moneyString(calculation.subtotal),
      discount: moneyString(calculation.discountTotal),
      delivery: moneyString(calculation.deliveryTotal),
      tax: moneyString(calculation.taxTotal),
      grand: moneyString(calculation.grandTotal),
      currency: "BDT",
    },
    items: calculation.lines.map((line: RuntimeValue) => ({
      variantId: line.variant.id,
      sku: line.variant.sku,
      name: line.translation?.name || line.product.slug,
      variantTitle: line.variant.title,
      attributes: line.variant.attributes,
      quantity: line.quantity,
      unitPrice: moneyString(line.unitPrice),
      discountTotal: calculation.promotions.lineDiscounts[line.id] || "0.00",
      lineTotal: moneyString(
        line.total.minus(calculation.promotions.lineDiscounts[line.id] || 0),
      ),
      available: line.available,
      stockPolicy: line.variant.stockPolicy,
    })),
  };
}

export async function quote(
  cartId: RuntimeValue,
  userId: RuntimeValue,
  input: RuntimeValue,
) {
  const payload: RuntimeValue = normalizeCheckoutPayload(input);
  await assertPaymentAvailable(payload.paymentMethod);
  const cart: RuntimeValue = await loadCart(cartId);
  if (!cart || cart.status !== "active")
    throw AppError.unprocessable(
      "CART_UNAVAILABLE",
      "Your cart is no longer active.",
    );
  const calculation: RuntimeValue = await calculateCart(
    cart,
    payload,
    userId,
    null,
    true,
  );
  const expiresAt = new Date(Date.now() + 10 * 60000);
  const storedPayload: RuntimeValue = {
    ...payload,
    cartVersion: Number(cart.version),
  };
  const totals: RuntimeValue = {
    subtotal: moneyString(calculation.subtotal),
    discount: moneyString(calculation.discountTotal),
    delivery: moneyString(calculation.deliveryTotal),
    tax: moneyString(calculation.taxTotal),
    grand: moneyString(calculation.grandTotal),
    items: calculation.lines.map((line: RuntimeValue) => ({
      variantId: line.variant.id,
      quantity: line.quantity,
      unitPrice: moneyString(line.unitPrice),
      discount: calculation.promotions.lineDiscounts[line.id] || "0.00",
    })),
  };
  const row: RuntimeValue = await CheckoutQuote.create({
    id: newId(),
    cartId,
    userId: userId || null,
    requestHash: sha256(
      canonicalJson({ cartId, cartVersion: cart.version, payload }),
    ),
    payload: storedPayload,
    totals,
    expiresAt,
  });
  return quoteDto(row, calculation);
}

function addressText(address: RuntimeValue) {
  return [
    address.addressLine,
    address.area,
    address.district,
    address.division,
    address.postcode,
  ]
    .filter(Boolean)
    .join(", ");
}

export function orderDto(
  order: RuntimeValue,
  includeInternal: RuntimeValue = false,
) {
  const shipping: RuntimeValue = order.addresses?.find(
    (item: RuntimeValue) => item.type === "shipping",
  );
  const events: RuntimeValue = (order.events || []).filter(
    (event: RuntimeValue) => includeInternal || event.public,
  );
  return {
    id: order.id,
    reference: order.reference,
    source: order.source,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentMethod: order.paymentMethod,
    customer: {
      name: order.customerName,
      phone: order.customerPhone,
      email: order.customerEmail,
    },
    address: shipping
      ? {
          recipientName: shipping.recipientName,
          phone: shipping.phone,
          addressLine: shipping.addressLine,
          area: shipping.area,
          district: shipping.district,
          division: shipping.division,
          postcode: shipping.postcode,
          landmark: shipping.landmark,
        }
      : order.address,
    delivery: {
      code: order.deliveryCode,
      label: order.deliveryLabel,
      total: moneyString(order.deliveryTotal),
    },
    totals: {
      subtotal: moneyString(order.subtotal),
      discount: moneyString(order.discountTotal),
      delivery: moneyString(order.deliveryTotal),
      tax: moneyString(order.taxTotal),
      grand: moneyString(order.grandTotal),
      currency: order.currency,
    },
    items:
      order.items?.map((item: RuntimeValue) => ({
        id: item.id,
        productId: item.variant?.productId || null,
        variantId: item.variantId,
        productName: item.productName,
        variantTitle: item.variantTitle,
        sku: item.sku,
        attributes: item.attributes,
        regularPrice: moneyString(item.regularPrice || item.unitPrice),
        salePrice: item.salePrice == null ? null : moneyString(item.salePrice),
        unitPrice: moneyString(item.unitPrice),
        discountTotal: moneyString(item.discountTotal),
        quantity: item.quantity,
        fulfilledQuantity: item.fulfilledQuantity,
        returnedQuantity: item.returnedQuantity,
        lineTotal: moneyString(item.lineTotal),
      })) || [],
    payments:
      order.payments?.map((payment: RuntimeValue) => ({
        id: payment.id,
        method: payment.method,
        amount: moneyString(payment.amount),
        currency: payment.currency,
        status: payment.status,
        paidAt: payment.paidAt,
      })) || [],
    events: events.map((event: RuntimeValue) => ({
      id: event.id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      message: event.message,
      public: event.public,
      createdAt: event.createdAt,
    })),
    note: order.note,
    cancellationReason: order.cancellationReason,
    version: order.version,
    placedAt: order.placedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function sameQuoteTotals(calculation: RuntimeValue, snapshot: RuntimeValue) {
  const current: RuntimeValue = {
    subtotal: moneyString(calculation.subtotal),
    discount: moneyString(calculation.discountTotal),
    delivery: moneyString(calculation.deliveryTotal),
    tax: moneyString(calculation.taxTotal),
    grand: moneyString(calculation.grandTotal),
    items: calculation.lines.map((line: RuntimeValue) => ({
      variantId: line.variant.id,
      quantity: line.quantity,
      unitPrice: moneyString(line.unitPrice),
      discount: calculation.promotions.lineDiscounts[line.id] || "0.00",
    })),
  };
  return canonicalJson(current) === canonicalJson(snapshot);
}

async function lockInventoryForCart(
  cart: RuntimeValue,
  transaction: RuntimeValue,
) {
  const variantIds: RuntimeValue = [
    ...new Set(cart.items.map((item: RuntimeValue) => item.variantId)),
  ].sort();
  const levels: RuntimeValue = await InventoryLevel.findAll({
    where: { variantId: { [Op.in]: variantIds } },
    order: [
      ["variantId", "ASC"],
      ["locationId", "ASC"],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const byVariant = new Map();
  for (const level of levels)
    byVariant.set(level.variantId, [
      ...(byVariant.get(level.variantId) || []),
      level,
    ]);
  for (const item of cart.items)
    item.variant.inventoryLevels = byVariant.get(item.variantId) || [];
  return levels;
}

async function reserveInventory(
  order: RuntimeValue,
  calculation: RuntimeValue,
  idempotencyKey: RuntimeValue,
  transaction: RuntimeValue,
  reservationStatus: RuntimeValue = "converted",
) {
  const allocations: RuntimeValue = [];
  const backorders: RuntimeValue = [];
  for (const line of calculation.lines) {
    let needed = line.quantity;
    const levels: RuntimeValue = [...line.variant.inventoryLevels].sort(
      (left: RuntimeValue, right: RuntimeValue) =>
        String(left.locationId).localeCompare(String(right.locationId)),
    );
    for (const level of levels) {
      if (needed <= 0) break;
      const available: RuntimeValue = Math.max(
        0,
        Number(level.onHand) - Number(level.reserved),
      );
      const quantity: RuntimeValue = Math.min(needed, available);
      if (!quantity) continue;
      const beforeReserved: RuntimeValue = Number(level.reserved);
      level.reserved = beforeReserved + quantity;
      level.version += 1;
      await level.save({ transaction });
      await InventoryReservation.create(
        {
          id: newId(),
          variantId: line.variant.id,
          locationId: level.locationId,
          cartId: order.metadata.cartId,
          orderId: order.id,
          quantity,
          status: reservationStatus,
          expiresAt: new Date(
            Date.now() +
              (reservationStatus === "active" ? 15 * 60000 : 365 * 86400000),
          ),
          convertedAt: reservationStatus === "converted" ? new Date() : null,
          idempotencyKey,
        },
        { transaction },
      );
      await InventoryMovement.create(
        {
          id: newId(),
          variantId: line.variant.id,
          locationId: level.locationId,
          orderId: order.id,
          quantityDelta: 0,
          reservedDelta: quantity,
          onHandBefore: Number(level.onHand),
          balanceAfter: Number(level.onHand),
          reservedAfter: Number(level.reserved),
          reason: "order_reserved",
          correlationId: idempotencyKey,
        },
        { transaction },
      );
      allocations.push({
        variantId: line.variant.id,
        locationId: level.locationId,
        quantity,
      });
      needed -= quantity;
    }
    if (needed > 0) {
      if (line.variant.stockPolicy === "deny")
        throw AppError.unprocessable(
          "INSUFFICIENT_STOCK",
          `Only ${line.quantity - needed} of ${line.variant.sku} are available.`,
        );
      backorders.push({
        variantId: line.variant.id,
        quantity: needed,
        policy: line.variant.stockPolicy,
        promisedAt: line.variant.preorderAvailableAt || null,
      });
    }
  }
  return { allocations, backorders };
}

export async function createLocalOrderFromQuote({
  cartId,
  userId,
  quoteId,
  idempotencyKey,
  paymentMethod,
  transaction,
  request = null,
}: RuntimeValue) {
  const checkoutQuote: RuntimeValue = await CheckoutQuote.findOne({
    where: { id: quoteId, cartId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!checkoutQuote || checkoutQuote.expiresAt <= new Date())
    throw AppError.unprocessable(
      "QUOTE_EXPIRED",
      "Your checkout quote expired. Review your order again.",
    );
  if (checkoutQuote.consumedAt)
    throw AppError.conflict(
      "QUOTE_ALREADY_USED",
      "This checkout quote was already used.",
    );
  if ((checkoutQuote.userId || null) !== (userId || null))
    throw AppError.forbidden("This checkout quote belongs to another account.");
  if (checkoutQuote.payload.paymentMethod !== paymentMethod)
    throw AppError.unprocessable(
      "PAYMENT_METHOD_MISMATCH",
      "Use the matching payment endpoint for this quote.",
    );
  const cart: RuntimeValue = await loadCart(
    cartId,
    transaction,
    transaction.LOCK.UPDATE,
  );
  if (!cart || cart.status !== "active")
    throw AppError.unprocessable(
      "CART_UNAVAILABLE",
      "Your cart is no longer active.",
    );
  if (Number(cart.version) !== Number(checkoutQuote.payload.cartVersion))
    throw AppError.conflict(
      "CART_CHANGED",
      "Your cart changed. Review checkout totals again.",
    );
  await lockInventoryForCart(cart, transaction);
  if (cart.coupons.length)
    await Coupon.findAll({
      where: {
        id: { [Op.in]: cart.coupons.map((coupon: RuntimeValue) => coupon.id) },
      },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  const calculation: RuntimeValue = await calculateCart(
    cart,
    checkoutQuote.payload,
    userId,
    transaction,
    true,
  );
  if (!sameQuoteTotals(calculation, checkoutQuote.totals))
    throw AppError.conflict(
      "QUOTE_CHANGED",
      "Price, stock, delivery, or discount changed. Review a new quote before placing the order.",
    );
  const pendingPayment = paymentMethod === "bkash";
  const order: RuntimeValue = await Order.create(
    {
      id: newId(),
      userId: userId || null,
      reference: orderReference(),
      source: "storefront",
      orderStatus: pendingPayment ? "pending_payment" : "placed",
      paymentStatus: pendingPayment ? "pending" : "unpaid",
      fulfillmentStatus: "unfulfilled",
      paymentMethod,
      customerName: checkoutQuote.payload.customer.name,
      customerPhone: checkoutQuote.payload.customer.phone,
      customerEmail: checkoutQuote.payload.customer.email,
      address: addressText(checkoutQuote.payload.address),
      deliveryCode: calculation.shipping.code,
      deliveryLabel: calculation.shipping.label,
      subtotal: moneyString(calculation.subtotal),
      discountTotal: moneyString(calculation.discountTotal),
      deliveryTotal: moneyString(calculation.deliveryTotal),
      taxTotal: moneyString(calculation.taxTotal),
      grandTotal: moneyString(calculation.grandTotal),
      currency: "BDT",
      locale: checkoutQuote.payload.locale,
      note: checkoutQuote.payload.note,
      placedAt: pendingPayment ? null : new Date(),
      metadata: { cartId, quoteId: checkoutQuote.id },
      version: 1,
    },
    { transaction },
  );
  for (const line of calculation.lines) {
    await OrderItem.create(
      {
        id: newId(),
        orderId: order.id,
        variantId: line.variant.id,
        productName: line.translation?.name || line.product.slug,
        variantTitle: line.variant.title,
        sku: line.variant.sku,
        attributes: line.variant.attributes,
        regularPrice: moneyString(line.regularPrice),
        salePrice: line.salePrice == null ? null : moneyString(line.salePrice),
        unitPrice: moneyString(line.unitPrice),
        unitCost: line.variant.costPrice,
        discountTotal: calculation.promotions.lineDiscounts[line.id] || "0.00",
        taxTotal: "0.00",
        quantity: line.quantity,
        fulfilledQuantity: 0,
        returnedQuantity: 0,
        lineTotal: moneyString(
          line.total.minus(calculation.promotions.lineDiscounts[line.id] || 0),
        ),
      },
      { transaction },
    );
  }
  for (const [type, value] of [
    ["shipping", checkoutQuote.payload.address],
    [
      "billing",
      checkoutQuote.payload.billingAddress || checkoutQuote.payload.address,
    ],
  ]) {
    await OrderAddress.create(
      {
        id: newId(),
        orderId: order.id,
        type,
        recipientName: value.recipientName,
        phone: value.phone,
        addressLine: value.addressLine,
        area: value.area || null,
        district: value.district || null,
        division: value.division || null,
        postcode: value.postcode || null,
        landmark: value.landmark || null,
        deliveryCode: calculation.shipping.code,
        snapshot: value,
      },
      { transaction },
    );
  }
  const payment: RuntimeValue = await Payment.create(
    {
      id: newId(),
      orderId: order.id,
      method: paymentMethod,
      provider: pendingPayment ? "bkash" : "manual",
      amount: moneyString(calculation.grandTotal),
      currency: "BDT",
      status: pendingPayment ? "pending" : "unpaid",
      version: 1,
      metadata: {},
    },
    { transaction },
  );
  const inventory: RuntimeValue = await reserveInventory(
    order,
    calculation,
    idempotencyKey,
    transaction,
    pendingPayment ? "active" : "converted",
  );
  order.metadata = { ...order.metadata, ...inventory };
  await order.save({ transaction });
  for (const applied of calculation.promotions.coupons)
    await CouponUsage.create(
      {
        id: newId(),
        couponId: applied.id,
        orderId: order.id,
        userId: userId || null,
        customerPhone: order.customerPhone,
        amount: applied.amount,
        status: pendingPayment ? "reserved" : "consumed",
      },
      { transaction },
    );
  await OrderEvent.create(
    {
      id: newId(),
      orderId: order.id,
      actorId: userId || null,
      type: pendingPayment ? "payment_pending" : "order_placed",
      fromStatus: null,
      toStatus: order.orderStatus,
      message: pendingPayment
        ? "Waiting for bKash payment."
        : "Order placed successfully.",
      public: true,
    },
    { transaction },
  );
  cart.status = "converted";
  cart.version += 1;
  await cart.save({ transaction });
  checkoutQuote.consumedAt = new Date();
  await checkoutQuote.save({ transaction });
  if (!pendingPayment) {
    await addDomainEvent({
      topic: "order.placed",
      aggregateType: "order",
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        reference: order.reference,
        total: moneyString(order.grandTotal),
        currency: "BDT",
        paymentMethod,
      },
      transaction,
    });
    await queueNotification({
      event: "order.placed",
      channel: order.customerEmail ? "email" : "sms",
      locale: order.locale,
      recipient: order.customerEmail || order.customerPhone,
      payload: {
        message: `Order ${order.reference} was placed successfully.`,
        orderReference: order.reference,
      },
      transaction,
    });
  }
  await recordAudit({
    actorId: userId || null,
    action: pendingPayment ? "order.pending_payment_create" : "order.create",
    resourceType: "order",
    resourceId: order.id,
    after: {
      reference: order.reference,
      total: moneyString(order.grandTotal),
      source: "storefront",
      paymentMethod,
    },
    request,
    transaction,
  });
  const hydrated: RuntimeValue = await Order.findByPk(order.id, {
    include: orderInclude,
    transaction,
  });
  return { order, payment, response: orderDto(hydrated) };
}

/** @param {import('express').Request | null | undefined} request */
export async function createOrder(
  cartId: RuntimeValue,
  userId: RuntimeValue,
  payload: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue = null,
) {
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  const actorKey = userId || cartId;
  const requestHash: RuntimeValue = sha256(canonicalJson(payload));
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const [record]: RuntimeValue = await IdempotencyRecord.findOrCreate({
      where: { scope: "orders.create", key: idempotencyKey, actorKey },
      defaults: {
        id: newId(),
        scope: "orders.create",
        key: idempotencyKey,
        actorKey,
        requestHash,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
      transaction,
    });
    await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (record.requestHash !== requestHash)
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This order key was already used for different details.",
      );
    if (record.responseBody) return record.responseBody;
    const { response }: RuntimeValue = await createLocalOrderFromQuote({
      cartId,
      userId,
      quoteId: payload.quoteId,
      idempotencyKey,
      paymentMethod: "cod",
      transaction,
      request,
    });
    record.responseStatus = 201;
    record.responseBody = response;
    await record.save({ transaction });
    return response;
  });
}

export async function releaseOrderReservations(
  orderId: RuntimeValue,
  reason: RuntimeValue,
  transaction: RuntimeValue,
  actorId: RuntimeValue = null,
  statuses: RuntimeValue = ["active", "converted"],
) {
  const reservations: RuntimeValue = await InventoryReservation.findAll({
    where: { orderId, status: { [Op.in]: statuses } },
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
    if (!level)
      throw new Error(
        "Inventory level missing for an active order reservation",
      );
    level.reserved = Math.max(
      0,
      Number(level.reserved) - Number(reservation.quantity),
    );
    level.version += 1;
    await level.save({ transaction });
    reservation.status = "released";
    reservation.releasedAt = new Date();
    await reservation.save({ transaction });
    await InventoryMovement.create(
      {
        id: newId(),
        variantId: reservation.variantId,
        locationId: reservation.locationId,
        orderId,
        actorId,
        quantityDelta: 0,
        reservedDelta: -Number(reservation.quantity),
        onHandBefore: Number(level.onHand),
        balanceAfter: Number(level.onHand),
        reservedAfter: Number(level.reserved),
        reason,
        correlationId: newId(),
      },
      { transaction },
    );
  }
  return reservations.length;
}

export async function listOrders(
  userId: RuntimeValue,
  query: RuntimeValue = {},
) {
  const page: RuntimeValue = Math.max(1, Number(query.page) || 1);
  const pageSize: RuntimeValue = Math.min(
    100,
    Math.max(1, Number(query.pageSize) || 20),
  );
  const where: RuntimeValue = { userId };
  if (query.status) where.orderStatus = query.status;
  const result: RuntimeValue = await Order.findAndCountAll({
    where,
    include: [
      {
        model: OrderItem,
        as: "items",
        include: [
          {
            model: ProductVariant,
            as: "variant",
            paranoid: false,
            attributes: ["id", "productId"],
          },
        ],
      },
      { model: Payment, as: "payments" },
    ],
    distinct: true,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map(orderDto),
    meta: {
      page,
      pageSize,
      total: result.count,
      pageCount: Math.ceil(result.count / pageSize),
    },
  };
}

export async function getOrder(id: RuntimeValue, userId: RuntimeValue) {
  const order: RuntimeValue = await Order.findOne({
    where: { id, userId },
    include: orderInclude,
    order: [[{ model: OrderEvent, as: "events" }, "createdAt", "ASC"]],
  });
  if (!order) throw AppError.notFound("Order not found.");
  return orderDto(order);
}

export async function trackOrder(
  reference: RuntimeValue,
  phoneInput: RuntimeValue,
) {
  const phone: RuntimeValue = normalizePhone(phoneInput);
  if (!phone) throw AppError.notFound("Order not found.");
  const order: RuntimeValue = await Order.findOne({
    where: { reference, customerPhone: phone },
    include: [
      {
        model: OrderItem,
        as: "items",
        attributes: ["id", "productName", "variantTitle", "quantity"],
      },
      {
        model: OrderEvent,
        as: "events",
        where: { public: true },
        required: false,
      },
    ],
  });
  if (!order) throw AppError.notFound("Order not found.");
  return {
    reference: order.reference,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    items: order.items,
    events: order.events.map((event: RuntimeValue) => ({
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    })),
    createdAt: order.createdAt,
  };
}

/** @param {import('express').Request | null | undefined} request */
export async function cancelOrder(
  id: RuntimeValue,
  userId: RuntimeValue,
  reason: RuntimeValue,
  request: RuntimeValue = null,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findOne({
      where: { id, userId },
      include: [{ model: OrderItem, as: "items" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    if (
      !["placed", "confirmed"].includes(order.orderStatus) ||
      order.fulfillmentStatus !== "unfulfilled"
    )
      throw AppError.conflict(
        "INVALID_ORDER_TRANSITION",
        "This order can no longer be cancelled online.",
      );
    if (order.paymentStatus === "paid")
      throw AppError.conflict(
        "PAID_ORDER_REQUIRES_SUPPORT",
        "Contact support to cancel a paid order and arrange a refund.",
      );
    await releaseOrderReservations(
      order.id,
      "order_cancelled",
      transaction,
      userId,
      ["converted"],
    );
    await CouponUsage.update(
      { status: "reversed" },
      { where: { orderId: order.id, status: "consumed" }, transaction },
    );
    order.orderStatus = "cancelled";
    order.paymentStatus = "cancelled";
    order.cancellationReason = reason;
    order.cancelledAt = new Date();
    order.version += 1;
    await order.save({ transaction });
    await Payment.update(
      { status: "cancelled", cancelledAt: new Date() },
      { where: { orderId: order.id, status: "unpaid" }, transaction },
    );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: order.id,
        actorId: userId,
        type: "order_cancelled",
        fromStatus: "placed",
        toStatus: "cancelled",
        message: "Order cancelled.",
        public: true,
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
      actorId: userId,
      action: "order.cancel",
      resourceType: "order",
      resourceId: order.id,
      before: { orderStatus: "placed" },
      after: { orderStatus: "cancelled", reason },
      request,
      transaction,
    });
    return orderDto(
      await Order.findByPk(order.id, { include: orderInclude, transaction }),
    );
  });
}
