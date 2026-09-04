import {
  MediaAsset,
  Order,
  OrderItem,
  Payment,
  Refund,
  ReturnEvent,
  ReturnItem,
  ReturnRequest,
  StockLocation,
  User,
} from '../../db/models.js';
import { env } from '../../config/env.js';
import { moneyString } from '../../lib/money.js';
import { signPrivateMedia } from '../media/media.storage.js';

export const returnDetailInclude = [
  { model: Order, as: 'order', include: [{ model: Payment, as: 'payments' }] },
  { model: ReturnItem, as: 'items', include: [{ model: OrderItem, as: 'orderItem' }, { model: StockLocation, as: 'restockLocation', required: false }] },
  { model: ReturnEvent, as: 'events', include: [{ model: User, as: 'actor', attributes: ['id', 'name'] }] },
  { model: MediaAsset, as: 'media', through: { attributes: ['displayOrder'] } },
  { model: Refund, as: 'refund', required: false },
  { model: Order, as: 'replacementOrder', required: false },
];

function privateMediaDto(asset) {
  const expires = Math.floor(Date.now() / 1000) + env.MEDIA_PRIVATE_URL_TTL_SECONDS;
  const signature = signPrivateMedia(asset.id, expires);
  return {
    id: asset.id,
    originalName: asset.originalName,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: Number(asset.byteSize),
    width: asset.width,
    height: asset.height,
    status: asset.status,
    url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expires}&signature=${encodeURIComponent(signature)}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export function returnDto(row, { internal = false } = {}) {
  const events = (row.events || []).filter((event) => internal || event.public);
  const order = row.order;
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    resolution: row.resolution,
    status: row.status,
    reason: row.reason,
    customerNote: row.customerNote,
    refundAmount: row.refundAmount == null ? null : moneyString(row.refundAmount),
    rejectionReason: row.rejectionReason || null,
    order: order ? {
      id: order.id,
      reference: order.reference,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      ...(internal ? { customer: { name: order.customerName, phone: order.customerPhone, email: order.customerEmail } } : {}),
    } : null,
    items: (row.items || []).map((item) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      quantity: Number(item.quantity),
      reason: item.reason,
      resolution: item.resolution,
      condition: item.condition || null,
      restock: item.restock == null ? null : Boolean(item.restock),
      restockLocation: item.restockLocation ? { id: item.restockLocation.id, code: item.restockLocation.code, name: item.restockLocation.name } : null,
      restockedAt: item.restockedAt || null,
      inspectionNote: item.inspectionNote || null,
      orderItem: item.orderItem ? {
        productName: item.orderItem.productName,
        variantTitle: item.orderItem.variantTitle,
        sku: item.orderItem.sku,
        attributes: item.orderItem.attributes,
        unitPrice: moneyString(item.orderItem.unitPrice),
        lineTotal: moneyString(item.orderItem.lineTotal),
        quantity: Number(item.orderItem.quantity),
        fulfilledQuantity: Number(item.orderItem.fulfilledQuantity),
        returnedQuantity: Number(item.orderItem.returnedQuantity),
      } : null,
    })),
    media: (row.media || []).sort((left, right) => Number(left.ReturnMedia?.displayOrder || 0) - Number(right.ReturnMedia?.displayOrder || 0)).map(privateMediaDto),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      public: event.public,
      actor: internal ? event.actor || null : undefined,
      metadata: internal ? event.metadata || null : undefined,
      createdAt: event.createdAt,
    })),
    refund: row.refund ? { id: row.refund.id, amount: moneyString(row.refund.amount), method: row.refund.method, status: row.refund.status, completedAt: row.refund.completedAt } : null,
    replacementOrder: row.replacementOrder ? { id: row.replacementOrder.id, reference: row.replacementOrder.reference, orderStatus: row.replacementOrder.orderStatus, paymentStatus: row.replacementOrder.paymentStatus, fulfillmentStatus: row.replacementOrder.fulfillmentStatus, metadata: internal ? row.replacementOrder.metadata : undefined } : null,
    policy: row.policySnapshot,
    version: Number(row.version),
    requestedAt: row.requestedAt,
    approvedAt: row.approvedAt,
    rejectedAt: row.rejectedAt,
    receivedAt: row.receivedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadReturnDetail(id, { transaction = null, internal = false } = {}) {
  const row = await ReturnRequest.findByPk(id, {
    include: returnDetailInclude,
    order: [[{ model: ReturnEvent, as: 'events' }, 'createdAt', 'ASC']],
    transaction,
  });
  return row ? returnDto(row, { internal }) : null;
}

