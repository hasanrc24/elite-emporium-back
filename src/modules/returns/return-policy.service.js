import { Op } from 'sequelize';
import {
  Order,
  OrderEvent,
  OrderItem,
  ProductVariant,
  ReturnItem,
  ReturnRequest,
  Shipment,
  StoreSetting,
} from '../../db/models.js';
import { AppError } from '../../lib/errors.js';
import { money, moneyString } from '../../lib/money.js';
import { normalizePhone } from '../../lib/normalization.js';
import { defaultPublicSettings } from '../settings/settings.service.js';

const consumingStatuses = ['requested', 'under_review', 'approved', 'in_transit', 'received', 'completed'];

export function refundableLineAmount(orderItem, quantity) {
  if (!orderItem.quantity || !quantity) return money(0);
  return money(orderItem.lineTotal).mul(quantity).div(Number(orderItem.quantity)).toDecimalPlaces(2);
}

export function evaluateReturnWindow({ enabled, windowDays, fulfillmentStatus, deliveredAt, now = new Date() }) {
  const deliveryDate = deliveredAt ? new Date(deliveredAt) : null;
  const deadline = deliveryDate ? new Date(deliveryDate.getTime() + Number(windowDays) * 86400000) : null;
  let reason = null;
  if (!enabled) reason = 'RETURNS_DISABLED';
  else if (!['delivered', 'partially_returned', 'returned'].includes(fulfillmentStatus)) reason = 'ORDER_NOT_DELIVERED';
  else if (!deliveryDate || Number.isNaN(deliveryDate.getTime())) reason = 'DELIVERY_DATE_UNAVAILABLE';
  else if (deadline < now) reason = 'RETURN_WINDOW_EXPIRED';
  return { eligible: !reason, reason, deliveredAt: deliveryDate, deadline };
}

export async function loadReturnPolicy(transaction = null, lock = false) {
  const options = { where: { key: 'returns' }, transaction };
  if (lock && transaction) options.lock = transaction.LOCK.UPDATE;
  const row = await StoreSetting.findOne(options);
  return {
    version: Number(row?.version || 0),
    value: { ...defaultPublicSettings.returns, ...(row?.value || {}) },
  };
}

export async function resolveReturnOrderAccess({ orderId = null, orderReference = null, phone = null, userId = null, transaction = null, lock = false }) {
  const where = userId
    ? { id: orderId, userId }
    : { reference: orderReference, customerPhone: normalizePhone(phone) || '__invalid__', userId: null };
  if (userId && !orderId) throw AppError.unprocessable('ORDER_REQUIRED', 'Choose an order for this request.');
  if (!userId && (!orderReference || !normalizePhone(phone))) throw AppError.notFound('Order not found.');
  const options = { where, transaction };
  if (lock && transaction) options.lock = transaction.LOCK.UPDATE;
  const order = await Order.findOne(options);
  if (!order) throw AppError.notFound('Order not found.');
  return order;
}

async function deliveredAtForOrder(order, transaction) {
  const shipment = await Shipment.findOne({
    where: { orderId: order.id, deliveredAt: { [Op.ne]: null } },
    order: [['deliveredAt', 'DESC']],
    transaction,
  });
  if (shipment?.deliveredAt) return new Date(shipment.deliveredAt);
  const event = await OrderEvent.findOne({
    where: { orderId: order.id, toStatus: 'delivered' },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  if (event?.createdAt) return new Date(event.createdAt);
  return order.completedAt ? new Date(order.completedAt) : null;
}

export async function calculateReturnEligibility(order, { transaction = null, lock = false } = {}) {
  const policy = await loadReturnPolicy(transaction, lock);
  const itemOptions = {
    where: { orderId: order.id },
    include: [{ model: ProductVariant, as: 'variant', attributes: ['id', 'productId'] }],
    order: [['id', 'ASC']],
    transaction,
  };
  if (lock && transaction) itemOptions.lock = transaction.LOCK.UPDATE;
  const orderItems = await OrderItem.findAll(itemOptions);
  const returnOptions = {
    where: { orderId: order.id, status: { [Op.in]: consumingStatuses } },
    attributes: ['id', 'status'],
    order: [['id', 'ASC']],
    transaction,
  };
  if (lock && transaction) returnOptions.lock = transaction.LOCK.UPDATE;
  const priorRequests = await ReturnRequest.findAll(returnOptions);
  const priorOptions = {
    where: { returnId: { [Op.in]: priorRequests.map((request) => request.id) } },
    order: [['orderItemId', 'ASC']],
    transaction,
  };
  if (lock && transaction) priorOptions.lock = transaction.LOCK.UPDATE;
  const priorItems = priorRequests.length ? await ReturnItem.findAll(priorOptions) : [];
  const priorByItem = new Map();
  for (const item of priorItems) priorByItem.set(item.orderItemId, (priorByItem.get(item.orderItemId) || 0) + Number(item.quantity));

  const deliveredAt = await deliveredAtForOrder(order, transaction);
  const now = new Date();
  const window = evaluateReturnWindow({ enabled: policy.value.enabled, windowDays: policy.value.windowDays, fulfillmentStatus: order.fulfillmentStatus, deliveredAt, now });
  const deadline = window.deadline;
  const globalReason = window.reason;
  const excluded = new Set(policy.value.excludedProductIds || []);

  const items = orderItems.map((item) => {
    const fulfilled = Number(item.fulfilledQuantity);
    const priorQuantity = priorByItem.get(item.id) || 0;
    const remainingQuantity = Math.max(0, fulfilled - priorQuantity);
    const excludedByPolicy = excluded.has(item.variant?.productId);
    let reason = globalReason;
    if (!reason && excludedByPolicy) reason = 'PRODUCT_EXCLUDED';
    if (!reason && fulfilled <= 0) reason = 'ITEM_NOT_FULFILLED';
    if (!reason && remainingQuantity <= 0) reason = 'NO_RETURNABLE_QUANTITY';
    return {
      orderItem: item,
      orderItemId: item.id,
      productId: item.variant?.productId || null,
      productName: item.productName,
      variantTitle: item.variantTitle,
      sku: item.sku,
      attributes: item.attributes,
      purchasedQuantity: Number(item.quantity),
      fulfilledQuantity: fulfilled,
      priorReturnQuantity: priorQuantity,
      eligibleQuantity: remainingQuantity,
      refundableAmount: moneyString(refundableLineAmount(item, remainingQuantity)),
      eligible: !reason,
      ineligibleReason: reason,
    };
  });
  const eligible = !globalReason && items.some((item) => item.eligible);
  const snapshot = {
    policyVersion: policy.version,
    enabled: Boolean(policy.value.enabled),
    windowDays: Number(policy.value.windowDays),
    guestReturns: Boolean(policy.value.guestReturns),
    excludedProductIds: [...excluded],
    deliveredAt: deliveredAt?.toISOString() || null,
    deadline: deadline?.toISOString() || null,
    evaluatedAt: now.toISOString(),
  };
  return { eligible, ineligibleReason: globalReason, policy: policy.value, snapshot, items };
}

export function eligibilityDto(order, eligibility) {
  return {
    order: { id: order.id, reference: order.reference, fulfillmentStatus: order.fulfillmentStatus },
    eligible: eligibility.eligible,
    ineligibleReason: eligibility.ineligibleReason,
    policy: eligibility.snapshot,
    items: eligibility.items.map(({ orderItem: _orderItem, ...item }) => item),
  };
}

export { consumingStatuses };
