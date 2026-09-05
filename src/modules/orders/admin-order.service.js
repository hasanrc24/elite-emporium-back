import { col, Op } from 'sequelize';
import {
  CouponUsage,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
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
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { orderReference } from '../../lib/ids.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256 } from '../../lib/crypto.js';
import { money, moneyString } from '../../lib/money.js';
import { dateRangeWhere } from '../../lib/date-range.js';
import { normalizeEmail, normalizePhone } from '../../lib/normalization.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { recordAudit } from '../audits/audit.service.js';
import { addDomainEvent, queueNotification } from '../events/outbox.service.js';
import { orderDto, releaseOrderReservations } from './order.service.js';

const detailInclude = [
  { model: OrderItem, as: 'items' },
  { model: OrderAddress, as: 'addresses' },
  { model: OrderEvent, as: 'events', include: [{ model: User, as: 'actor', attributes: ['id', 'name'] }] },
  { model: OrderNote, as: 'notes', include: [{ model: User, as: 'actor', attributes: ['id', 'name'] }] },
  { model: Payment, as: 'payments', include: [{ model: PaymentAttempt, as: 'attempts' }] },
  { model: Shipment, as: 'shipments' },
];

function effectiveVariantPrice(variant, now = new Date()) {
  const saleIsCurrent = variant.salePrice != null && (!variant.saleStartsAt || variant.saleStartsAt <= now) && (!variant.saleEndsAt || variant.saleEndsAt > now) && money(variant.salePrice).lessThan(variant.regularPrice);
  return saleIsCurrent ? money(variant.salePrice) : money(variant.regularPrice);
}

export async function createManualOrder(payload, actorId, permissions, idempotencyKey, request) {
  if (!idempotencyKey) throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
  const requestHash = sha256(canonicalJson(payload));
  return sequelize.transaction(async (transaction) => {
    const [record] = await IdempotencyRecord.findOrCreate({ where: { scope: 'admin.orders.create', key: idempotencyKey, actorKey: actorId }, defaults: { id: newId(), scope: 'admin.orders.create', key: idempotencyKey, actorKey: actorId, requestHash, expiresAt: new Date(Date.now() + 365 * 86400000) }, transaction });
    await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (record.requestHash !== requestHash) throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'This key was already used for a different manual order.');
    if (record.responseBody?.orderId) return getAdminOrderWithinTransaction(record.responseBody.orderId, transaction);
    const phone = normalizePhone(payload.customer.phone); const email = normalizeEmail(payload.customer.email);
    if (!phone) throw AppError.unprocessable('INVALID_PHONE', 'Enter a valid Bangladeshi customer phone number.');
    const variantIds = [...new Set(payload.items.map((item) => item.variantId))].sort();
    if (variantIds.length !== payload.items.length) throw AppError.unprocessable('DUPLICATE_VARIANT', 'Combine duplicate variants into one line.');
    const variants = await ProductVariant.findAll({ where: { id: { [Op.in]: variantIds }, status: 'active', active: true }, include: [{ model: Product, as: 'product', required: true, include: [{ model: ProductTranslation, as: 'translations' }] }], order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (variants.length !== variantIds.length) throw AppError.unprocessable('INVALID_VARIANT', 'One or more variants are unavailable.');
    const byId = new Map(variants.map((variant) => [variant.id, variant])); const now = new Date(); let subtotal = money(0); const lines = [];
    for (const requested of payload.items) {
      const variant = byId.get(requested.variantId); const standard = effectiveVariantPrice(variant, now); const selected = requested.unitPrice == null ? standard : money(requested.unitPrice);
      if (!selected.equals(standard) && !permissions.has('orders.override_price')) throw AppError.forbidden('Price override permission is required.');
      if (!selected.equals(standard) && !payload.overrideReason) throw AppError.unprocessable('OVERRIDE_REASON_REQUIRED', 'A reason is required for price overrides.');
      const total = selected.times(requested.quantity); subtotal = subtotal.plus(total); lines.push({ variant, quantity: requested.quantity, unitPrice: selected, lineTotal: total });
    }
    const discount = money(payload.manualDiscount || 0); if (discount.isNegative() || discount.greaterThan(subtotal)) throw AppError.unprocessable('INVALID_MANUAL_DISCOUNT', 'Manual discount cannot exceed the item subtotal.');
    if (discount.isPositive() && !payload.discountReason) throw AppError.unprocessable('DISCOUNT_REASON_REQUIRED', 'A reason is required for a manual discount.');
    const method = await ShippingMethod.findOne({ where: { code: payload.deliveryCode, active: true }, transaction }); if (!method) throw AppError.unprocessable('INVALID_DELIVERY_METHOD', 'Choose an active delivery method.');
    const delivery = method.freeThreshold != null && subtotal.minus(discount).greaterThanOrEqualTo(method.freeThreshold) ? money(0) : money(method.flatRate); const grand = subtotal.minus(discount).plus(delivery);
    const customer = payload.customerId ? await User.findByPk(payload.customerId, { transaction }) : null; if (payload.customerId && !customer) throw AppError.unprocessable('INVALID_CUSTOMER', 'Customer account not found.');
    const order = await Order.create({ id: newId(), userId: customer?.id || null, reference: orderReference(), source: 'admin', orderStatus: payload.status, paymentStatus: payload.status === 'draft' ? 'unpaid' : 'unpaid', fulfillmentStatus: 'unfulfilled', paymentMethod: 'cod', customerName: payload.customer.name, customerPhone: phone, customerEmail: email, address: [payload.address.addressLine, payload.address.area, payload.address.district, payload.address.division, payload.address.postcode].filter(Boolean).join(', '), deliveryCode: method.code, deliveryLabel: payload.locale === 'bn' ? method.labelBn : method.labelEn, subtotal: moneyString(subtotal), discountTotal: moneyString(discount), deliveryTotal: moneyString(delivery), taxTotal: '0.00', grandTotal: moneyString(grand), currency: 'BDT', locale: payload.locale, note: payload.note || null, placedAt: payload.status === 'placed' ? now : null, metadata: { manual: true, overrideReason: payload.overrideReason || null, discountReason: payload.discountReason || null }, version: 1 }, { transaction });
    const lineDiscounts = []; let allocated = money(0);
    for (const [index, line] of lines.entries()) { const lineDiscount = index === lines.length - 1 ? discount.minus(allocated) : discount.times(line.lineTotal).div(subtotal).toDecimalPlaces(2); allocated = allocated.plus(lineDiscount); lineDiscounts.push(lineDiscount); const translation = line.variant.product.translations?.find((item) => item.locale === payload.locale) || line.variant.product.translations?.find((item) => item.locale === 'en'); await OrderItem.create({ id: newId(), orderId: order.id, variantId: line.variant.id, productName: translation?.name || line.variant.product.slug, variantTitle: line.variant.title, sku: line.variant.sku, attributes: line.variant.attributes, regularPrice: moneyString(line.variant.regularPrice), salePrice: line.variant.salePrice == null ? null : moneyString(line.variant.salePrice), unitPrice: moneyString(line.unitPrice), unitCost: line.variant.costPrice, discountTotal: moneyString(lineDiscount), taxTotal: '0.00', quantity: line.quantity, fulfilledQuantity: 0, returnedQuantity: 0, lineTotal: moneyString(line.lineTotal.minus(lineDiscount)) }, { transaction }); }
    for (const type of ['shipping', 'billing']) await OrderAddress.create({ id: newId(), orderId: order.id, type, recipientName: payload.customer.name, phone, addressLine: payload.address.addressLine, area: payload.address.area || null, district: payload.address.district || null, division: payload.address.division || null, postcode: payload.address.postcode || null, landmark: payload.address.landmark || null, deliveryCode: method.code, snapshot: payload.address }, { transaction });
    await Payment.create({ id: newId(), orderId: order.id, method: 'cod', provider: 'manual', amount: moneyString(grand), currency: 'BDT', status: 'unpaid', version: 1, metadata: { createdBy: actorId } }, { transaction });
    if (payload.status === 'placed') {
      for (const line of lines) { let needed = line.quantity; const levels = await InventoryLevel.findAll({ where: { variantId: line.variant.id }, order: [['locationId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE }); for (const level of levels) { const available = Number(level.onHand) - Number(level.reserved); const quantity = Math.min(needed, Math.max(0, available)); if (!quantity) continue; await level.update({ reserved: Number(level.reserved) + quantity, version: Number(level.version) + 1 }, { transaction }); await InventoryReservation.create({ id: newId(), variantId: line.variant.id, locationId: level.locationId, orderId: order.id, quantity, status: 'converted', expiresAt: new Date(Date.now() + 365 * 86400000), convertedAt: now, idempotencyKey }, { transaction }); await InventoryMovement.create({ id: newId(), variantId: line.variant.id, locationId: level.locationId, orderId: order.id, actorId, quantityDelta: 0, reservedDelta: quantity, onHandBefore: Number(level.onHand), balanceAfter: Number(level.onHand), reservedAfter: Number(level.reserved), reason: 'manual_order_reserved', correlationId: idempotencyKey }, { transaction }); needed -= quantity; if (!needed) break; } if (needed && line.variant.stockPolicy === 'deny') throw AppError.unprocessable('INSUFFICIENT_STOCK', `Insufficient stock for ${line.variant.sku}.`); }
    }
    await OrderEvent.create({ id: newId(), orderId: order.id, actorId, type: 'manual_order_created', toStatus: order.orderStatus, message: payload.status === 'placed' ? 'Order placed by staff.' : 'Draft order created by staff.', public: payload.status === 'placed' }, { transaction });
    await recordAudit({ actorId, action: 'order.manual_create', resourceType: 'order', resourceId: order.id, after: { reference: order.reference, status: order.orderStatus, total: moneyString(grand) }, metadata: { overrideReason: payload.overrideReason || null, discountReason: payload.discountReason || null, idempotencyKey }, request, transaction });
    record.responseStatus = 201; record.responseBody = { orderId: order.id }; await record.save({ transaction });
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

export async function listAdminOrders(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = {};
  if (query.orderStatus) where.orderStatus = query.orderStatus;
  if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
  if (query.fulfillmentStatus) where.fulfillmentStatus = query.fulfillmentStatus;
  if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
  if (query.source) where.source = query.source;
  if (query.deliveryCode) where.deliveryCode = query.deliveryCode;
  Object.assign(where, dateRangeWhere(query));
  if (query.search) where[Op.or] = [{ reference: { [Op.like]: `%${String(query.search).slice(0, 80)}%` } }, { customerPhone: { [Op.like]: `%${String(query.search).slice(0, 30)}%` } }, { customerEmail: { [Op.like]: `%${String(query.search).slice(0, 100)}%` } }, { customerName: { [Op.like]: `%${String(query.search).slice(0, 100)}%` } }];
  const result = await Order.findAndCountAll({ where, include: [{ model: Payment, as: 'payments' }], distinct: true, limit, offset, order: [['createdAt', 'DESC']] });
  return { data: result.rows.map((order) => orderDto(order, true)), meta: pageEnvelope(result, page, pageSize).meta };
}

export async function getAdminOrder(id) {
  const order = await Order.findByPk(id, { include: detailInclude, order: [[{ model: OrderEvent, as: 'events' }, 'createdAt', 'ASC'], [{ model: OrderNote, as: 'notes' }, 'createdAt', 'ASC']] });
  if (!order) throw AppError.notFound('Order not found.');
  return { ...orderDto(order, true), notes: order.notes.map((note) => ({ id: note.id, visibility: note.visibility, message: note.message, actor: note.actor, createdAt: note.createdAt })), shipments: order.shipments, metadata: order.metadata };
}

const orderTransitions = {
  draft: ['pending_payment', 'placed', 'cancelled'],
  pending_payment: ['placed', 'failed', 'cancelled'],
  placed: ['confirmed', 'processing', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  completed: [], cancelled: [], failed: [],
};
const fulfillmentTransitions = {
  unfulfilled: ['processing', 'packed'],
  processing: ['packed'],
  packed: ['shipped'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered: ['partially_returned', 'returned'],
  partially_returned: ['returned'],
  returned: [],
};

async function consumeReservations(order, actorId, transaction) {
  if (order.metadata?.backorders?.some((item) => item.quantity > 0)) throw AppError.conflict('BACKORDER_ALLOCATION_REQUIRED', 'Allocate all backordered quantities before packing this order.');
  const reservations = await InventoryReservation.findAll({ where: { orderId: order.id, status: 'converted' }, order: [['variantId', 'ASC'], ['locationId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  for (const reservation of reservations) {
    const level = await InventoryLevel.findOne({ where: { variantId: reservation.variantId, locationId: reservation.locationId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!level || Number(level.onHand) < Number(reservation.quantity) || Number(level.reserved) < Number(reservation.quantity)) throw AppError.conflict('INVENTORY_RESERVATION_INVALID', 'Reserved inventory no longer matches the order. Reconcile it before packing.');
    const before = Number(level.onHand);
    level.onHand = before - Number(reservation.quantity);
    level.reserved = Number(level.reserved) - Number(reservation.quantity);
    level.version += 1;
    await level.save({ transaction });
    reservation.status = 'consumed';
    reservation.consumedAt = new Date();
    await reservation.save({ transaction });
    await InventoryMovement.create({ id: newId(), variantId: reservation.variantId, locationId: reservation.locationId, orderId: order.id, actorId, quantityDelta: -Number(reservation.quantity), reservedDelta: -Number(reservation.quantity), onHandBefore: before, balanceAfter: Number(level.onHand), reservedAfter: Number(level.reserved), reason: 'order_fulfilled', correlationId: `fulfillment:${order.id}` }, { transaction });
  }
  await OrderItem.update({ fulfilledQuantity: col('quantity') }, { where: { orderId: order.id }, transaction });
}

export async function transitionOrder(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw AppError.notFound('Order not found.');
    if (Number(payload.version) !== Number(order.version)) throw AppError.conflict('VERSION_CONFLICT', 'This order changed. Refresh and review the latest state.');
    const before = { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, version: order.version };
    if (payload.dimension === 'order') {
      if (!orderTransitions[order.orderStatus]?.includes(payload.status)) throw AppError.conflict('INVALID_ORDER_TRANSITION', `Order cannot move from ${order.orderStatus} to ${payload.status}.`);
      if (payload.status === 'completed' && (order.fulfillmentStatus !== 'delivered' || order.paymentStatus !== 'paid')) throw AppError.conflict('ORDER_NOT_COMPLETABLE', 'An order can complete only after delivery and payment.');
      if (payload.status === 'cancelled') throw AppError.unprocessable('USE_CANCEL_ACTION', 'Use the cancel action so inventory and promotions are reversed safely.');
      order.orderStatus = payload.status;
      if (payload.status === 'completed') order.completedAt = new Date();
    } else {
      if (!fulfillmentTransitions[order.fulfillmentStatus]?.includes(payload.status)) throw AppError.conflict('INVALID_FULFILLMENT_TRANSITION', `Fulfillment cannot move from ${order.fulfillmentStatus} to ${payload.status}.`);
      if (payload.status === 'packed') await consumeReservations(order, actorId, transaction);
      order.fulfillmentStatus = payload.status;
      if (['processing', 'packed', 'shipped', 'out_for_delivery'].includes(payload.status) && ['placed', 'confirmed'].includes(order.orderStatus)) order.orderStatus = 'processing';
      if (payload.status === 'delivered' && order.paymentStatus === 'paid') { order.orderStatus = 'completed'; order.completedAt = new Date(); }
    }
    order.version += 1;
    await order.save({ transaction });
    await OrderEvent.create({ id: newId(), orderId: order.id, actorId, type: `${payload.dimension}_transition`, fromStatus: payload.dimension === 'order' ? before.orderStatus : before.fulfillmentStatus, toStatus: payload.status, message: payload.message || `Status updated to ${payload.status}.`, public: payload.public }, { transaction });
    await addDomainEvent({ topic: `order.${payload.status}`, aggregateType: 'order', aggregateId: order.id, payload: { orderId: order.id, reference: order.reference, dimension: payload.dimension, status: payload.status }, transaction });
    if (payload.public) await queueNotification({ event: `order.${payload.status}`, channel: order.customerEmail ? 'email' : 'sms', locale: order.locale, recipient: order.customerEmail || order.customerPhone, payload: { message: payload.message || `Order ${order.reference} is now ${payload.status}.`, orderReference: order.reference }, transaction });
    await recordAudit({ actorId, action: 'order.transition', resourceType: 'order', resourceId: order.id, before, after: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, version: order.version }, metadata: { reason: payload.reason }, request, transaction });
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

async function getAdminOrderWithinTransaction(id, transaction) {
  const order = await Order.findByPk(id, { include: detailInclude, transaction });
  return { ...orderDto(order, true), notes: order.notes.map((note) => ({ id: note.id, visibility: note.visibility, message: note.message, actor: note.actor, createdAt: note.createdAt })), shipments: order.shipments, metadata: order.metadata };
}

export async function cancelAdminOrder(id, reason, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw AppError.notFound('Order not found.');
    if (['completed', 'cancelled'].includes(order.orderStatus) || ['delivered', 'returned'].includes(order.fulfillmentStatus)) throw AppError.conflict('INVALID_ORDER_TRANSITION', 'This order cannot be cancelled.');
    if (['paid', 'partially_refunded'].includes(order.paymentStatus)) throw AppError.conflict('REFUND_REQUIRED', 'Create the required refund before cancelling this paid order.');
    const before = { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus };
    await releaseOrderReservations(order.id, 'admin_order_cancelled', transaction, actorId, ['active', 'converted']);
    await CouponUsage.update({ status: 'reversed' }, { where: { orderId: order.id, status: { [Op.in]: ['reserved', 'consumed'] } }, transaction });
    order.orderStatus = 'cancelled';
    order.paymentStatus = 'cancelled';
    order.cancellationReason = reason;
    order.cancelledAt = new Date();
    order.version += 1;
    await order.save({ transaction });
    await Payment.update({ status: 'cancelled', cancelledAt: new Date() }, { where: { orderId: order.id, status: { [Op.in]: ['unpaid', 'pending'] } }, transaction });
    await OrderEvent.create({ id: newId(), orderId: order.id, actorId, type: 'order_cancelled', fromStatus: before.orderStatus, toStatus: 'cancelled', message: 'Order cancelled by staff.', public: true, metadata: { reason } }, { transaction });
    await recordAudit({ actorId, action: 'order.admin_cancel', resourceType: 'order', resourceId: order.id, before, after: { orderStatus: 'cancelled', paymentStatus: 'cancelled' }, metadata: { reason }, request, transaction });
    return getAdminOrderWithinTransaction(order.id, transaction);
  });
}

export async function addOrderNote(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(id, { transaction });
    if (!order) throw AppError.notFound('Order not found.');
    const note = await OrderNote.create({ id: newId(), orderId: id, actorId, visibility: payload.visibility, message: payload.message }, { transaction });
    if (payload.visibility === 'customer') await OrderEvent.create({ id: newId(), orderId: id, actorId, type: 'customer_note', message: payload.message, public: true }, { transaction });
    await recordAudit({ actorId, action: 'order.note_add', resourceType: 'order', resourceId: id, metadata: { noteId: note.id, visibility: payload.visibility }, request, transaction });
    return { id: note.id, visibility: note.visibility, message: note.message, createdAt: note.createdAt };
  });
}

export async function listPayments(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = {};
  if (query.status) where.status = query.status;
  if (query.method) where.method = query.method;
  Object.assign(where, dateRangeWhere(query));
  const result = await Payment.findAndCountAll({ where, include: [{ model: Order, as: 'order', where: query.search ? { [Op.or]: [{ reference: { [Op.like]: `%${String(query.search).slice(0, 80)}%` } }, { customerPhone: { [Op.like]: `%${String(query.search).slice(0, 30)}%` } }] } : undefined }, { model: PaymentAttempt, as: 'attempts' }], distinct: true, limit, offset, order: [['createdAt', 'DESC']] });
  return { data: result.rows.map(paymentDto), meta: pageEnvelope(result, page, pageSize).meta };
}

function paymentDto(payment) {
  return { id: payment.id, order: payment.order ? { id: payment.order.id, reference: payment.order.reference, customerName: payment.order.customerName, customerPhone: payment.order.customerPhone } : null, method: payment.method, provider: payment.provider, amount: moneyString(payment.amount), currency: payment.currency, status: payment.status, transactionId: payment.providerTransactionId, reference: payment.reference, paidAt: payment.paidAt, version: payment.version, attempts: payment.attempts?.map((attempt) => ({ id: attempt.id, providerPaymentId: attempt.providerPaymentId, status: attempt.status, expiresAt: attempt.expiresAt, createdAt: attempt.createdAt })) || [], createdAt: payment.createdAt };
}

export async function getPayment(id) {
  const payment = await Payment.findByPk(id, { include: [{ model: Order, as: 'order' }, { model: PaymentAttempt, as: 'attempts' }] });
  if (!payment) throw AppError.notFound('Payment not found.');
  return paymentDto(payment);
}

export async function collectCod(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(id, { include: [{ model: Order, as: 'order' }], transaction, lock: transaction.LOCK.UPDATE });
    if (!payment || payment.method !== 'cod') throw AppError.notFound('COD payment not found.');
    if (payment.status === 'paid') return paymentDto(payment);
    if (payment.status !== 'unpaid') throw AppError.conflict('PAYMENT_NOT_COLLECTABLE', 'This payment cannot be marked as collected.');
    if (!money(payload.amount).equals(payment.amount)) throw AppError.unprocessable('COLLECTION_AMOUNT_MISMATCH', `Collected amount must equal ${moneyString(payment.amount)}.`);
    payment.status = 'paid';
    payment.paidAt = payload.collectedAt ? new Date(payload.collectedAt) : new Date();
    payment.reference = payload.reference || null;
    payment.metadata = { ...payment.metadata, collectorId: actorId, collectionNote: payload.note || null };
    payment.version += 1;
    await payment.save({ transaction });
    payment.order.paymentStatus = 'paid';
    if (payment.order.fulfillmentStatus === 'delivered') { payment.order.orderStatus = 'completed'; payment.order.completedAt = new Date(); }
    payment.order.version += 1;
    await payment.order.save({ transaction });
    await OrderEvent.create({ id: newId(), orderId: payment.order.id, actorId, type: 'cod_collected', message: 'Cash on delivery payment collected.', public: true, metadata: { paymentId: payment.id, reference: payment.reference } }, { transaction });
    await addDomainEvent({ topic: 'payment.paid', aggregateType: 'payment', aggregateId: payment.id, payload: { paymentId: payment.id, orderId: payment.order.id, amount: moneyString(payment.amount), method: 'cod' }, transaction });
    await recordAudit({ actorId, action: 'payment.cod_collect', resourceType: 'payment', resourceId: payment.id, before: { status: 'unpaid' }, after: { status: 'paid', amount: moneyString(payment.amount), reference: payment.reference }, request, transaction });
    return paymentDto(payment);
  });
}
