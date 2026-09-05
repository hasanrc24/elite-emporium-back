import { Op, col, fn, literal } from 'sequelize';
import {
  AuditLog, ContactMessage, CouponUsage, ExportJob, InventoryLevel, InventoryMovement, MediaAsset, NotificationOutbox,
  NotificationTemplate, Order, OrderItem, OutboxEvent, Payment, Product, ProductVariant, Refund, ReturnRequest, User,
  Webhook, WebhookDelivery,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { encryptSecret } from '../../lib/encryption.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { moneyString } from '../../lib/money.js';
import { dateRangeWhere } from '../../lib/date-range.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { env } from '../../config/env.js';
import { signPrivateMedia } from '../media/media.storage.js';
import { renderTemplate, deliverWebhook } from '../../jobs/job-runner.js';
import { recordAudit } from '../audits/audit.service.js';
import { addDomainEvent } from '../events/outbox.service.js';

function dateRange(query, field = 'createdAt') {
  return dateRangeWhere(query, field);
}

export async function listAudits(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = /** @type {any} */ ({ ...dateRange(query) });
  if (query.action) where.action = { [Op.like]: `%${String(query.action).slice(0, 120)}%` };
  if (query.resourceType) where.resourceType = String(query.resourceType).slice(0, 100);
  if (query.resourceId) where.resourceId = String(query.resourceId).slice(0, 26);
  if (query.actorId) where.actorId = String(query.actorId).slice(0, 26);
  if (query.requestId) where.requestId = String(query.requestId).slice(0, 100);
  const result = await AuditLog.findAndCountAll({ where, include: [{ model: User, as: 'actor', attributes: ['id', 'name', 'email'], required: false, paranoid: false }], limit, offset, order: [['createdAt', 'DESC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function listNotificationTemplates(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = {};
  if (query.event) where.event = { [Op.like]: `%${String(query.event).slice(0, 100)}%` };
  if (query.channel) where.channel = query.channel;
  if (query.locale) where.locale = query.locale;
  const result = await NotificationTemplate.findAndCountAll({ where, limit, offset, order: [['event', 'ASC'], ['channel', 'ASC'], ['locale', 'ASC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function getNotificationTemplate(id) {
  const row = await NotificationTemplate.findByPk(id);
  if (!row) throw AppError.notFound('Notification template not found.');
  return row;
}

export async function previewNotificationTemplate(id, variables) {
  const row = await getNotificationTemplate(id);
  try { return { ...renderTemplate(row, variables), channel: row.channel, locale: row.locale }; }
  catch (error) { throw AppError.unprocessable('TEMPLATE_RENDER_FAILED', error.message); }
}

export async function testNotificationTemplate(id, payload, actorId, request) {
  const row = await getNotificationTemplate(id);
  const rendered = await previewNotificationTemplate(id, payload.variables);
  const delivery = await NotificationOutbox.create({ id: newId(), event: `template.test.${row.event}`, channel: row.channel, locale: row.locale, recipient: payload.recipient, templateId: row.id, payload: payload.variables, renderedSubject: rendered.subject, renderedBody: rendered.body, status: 'pending', attempts: 0, scheduledAt: new Date() });
  await recordAudit({ actorId, action: 'notification.template_test', resourceType: 'notification_template', resourceId: row.id, metadata: { deliveryId: delivery.id, channel: row.channel }, request, transaction: null });
  return { deliveryId: delivery.id, status: delivery.status };
}

function assertTemplateVariables(body, allowed) {
  const referenced = [...String(body).matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)].map((match) => match[1]);
  const invalid = referenced.filter((variable) => !allowed.includes(variable));
  if (invalid.length) throw AppError.unprocessable('UNKNOWN_TEMPLATE_VARIABLE', `Unknown template variables: ${[...new Set(invalid)].join(', ')}.`);
}

export async function updateNotificationTemplate(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const row = await NotificationTemplate.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw AppError.notFound('Notification template not found.');
    if (Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'This template changed. Refresh and review it.');
    assertTemplateVariables(`${payload.subject || ''}\n${payload.body}`, row.variables || []);
    const before = row.toJSON();
    await row.update({ subject: payload.subject ?? null, body: payload.body, active: payload.active, version: row.version + 1 }, { transaction });
    await recordAudit({ actorId, action: 'notification.template_update', resourceType: 'notification_template', resourceId: row.id, before, after: row.toJSON(), request, transaction });
    return row;
  });
}

export async function listNotificationOutbox(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = /** @type {any} */ ({ ...dateRange(query) });
  if (query.status) where.status = query.status;
  if (query.channel) where.channel = query.channel;
  if (query.event) where.event = { [Op.like]: `%${String(query.event).slice(0, 100)}%` };
  const result = await NotificationOutbox.findAndCountAll({ where, attributes: { exclude: ['payload', 'renderedBody'] }, limit, offset, order: [['createdAt', 'DESC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function getNotificationDelivery(id) {
  const row = await NotificationOutbox.findByPk(id, { attributes: { exclude: ['payload'] } });
  if (!row) throw AppError.notFound('Notification delivery not found.');
  return row;
}

export async function retryNotification(id, actorId, request) {
  const row = await NotificationOutbox.findByPk(id);
  if (!row) throw AppError.notFound('Notification delivery not found.');
  if (!['retry', 'dead'].includes(row.status)) throw AppError.conflict('NOT_RETRYABLE', 'Only retry or dead deliveries can be queued again.');
  const before = { status: row.status, attempts: row.attempts };
  await row.update({ status: 'pending', scheduledAt: new Date(), errorCode: null, lastError: null });
  await recordAudit({ actorId, action: 'notification.retry', resourceType: 'notification_outbox', resourceId: row.id, before, after: { status: row.status, attempts: row.attempts }, request, transaction: null });
  return row;
}

export async function reportSummary(query) {
  const range = dateRange(query);
  const placed = { ...range, orderStatus: { [Op.in]: ['placed', 'confirmed', 'processing', 'completed'] } };
  const [orderCount, revenue, refunds, returns, customers, products, lowStock, paymentFailures] = await Promise.all([
    Order.count({ where: range }),
    Order.findOne({ attributes: [[fn('COALESCE', fn('SUM', col('grandTotal')), 0), 'total']], where: placed, raw: true }),
    Refund.findOne({ attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']], where: { ...range, status: 'completed' }, raw: true }),
    ReturnRequest.count({ where: range }), User.count({ where: range }), Product.count({ where: range }),
    InventoryLevel.count({ where: { onHand: { [Op.lte]: col('lowStockThreshold') } } }),
    Payment.count({ where: { ...range, status: 'failed' } }),
  ]);
  const grossRevenue = moneyString(revenue?.total || 0);
  const refundAmount = moneyString(refunds?.total || 0);
  const averageOrderValue = orderCount ? moneyString(Number(grossRevenue) / orderCount) : '0.00';
  return { range: { from: query.from || null, to: query.to || null, timezone: 'Asia/Dhaka' }, orderCount, grossRevenue, refundAmount, averageOrderValue, returns, customers, products, lowStock, paymentFailures };
}

export async function reportData(report, query) {
  const summary = await reportSummary(query); const range = dateRange(query);
  let rows;
  if (report === 'gross_profit') {
    rows = await OrderItem.findAll({ attributes: [[fn('DATE', col('OrderItem.createdAt')), 'date'], [fn('COALESCE', fn('SUM', col('lineTotal')), 0), 'netItemRevenue'], [literal('COALESCE(SUM(COALESCE(`unitCost`, 0) * `quantity`), 0)'), 'costOfGoods'], [literal('COALESCE(SUM(`lineTotal` - (COALESCE(`unitCost`, 0) * `quantity`)), 0)'), 'grossProfit']], where: range, group: [fn('DATE', col('OrderItem.createdAt'))], order: [[fn('DATE', col('OrderItem.createdAt')), 'ASC']], raw: true });
  } else if (['sales', 'net_revenue', 'orders', 'aov', 'discounts', 'delivery', 'tax'].includes(report)) {
    const attributes = [[fn('DATE', col('createdAt')), 'date'], [fn('COUNT', col('id')), 'orders'], [fn('COALESCE', fn('SUM', col('grandTotal')), 0), 'grossRevenue'], [fn('COALESCE', fn('SUM', col('discountTotal')), 0), 'discounts'], [fn('COALESCE', fn('SUM', col('deliveryTotal')), 0), 'delivery'], [fn('COALESCE', fn('SUM', col('taxTotal')), 0), 'tax']];
    rows = await Order.findAll({ attributes, where: range, group: [fn('DATE', col('createdAt'))], order: [[fn('DATE', col('createdAt')), 'ASC']], raw: true });
  } else if (report === 'payments' || report === 'payment_method') rows = await Payment.findAll({ attributes: ['method', 'status', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('amount')), 0), 'amount']], where: range, group: ['method', 'status'], raw: true });
  else if (report === 'refunds') rows = await Refund.findAll({ attributes: ['method', 'status', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('amount')), 0), 'amount']], where: range, group: ['method', 'status'], raw: true });
  else if (report === 'returns') rows = await ReturnRequest.findAll({ attributes: ['status', 'resolution', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('requestedAmount')), 0), 'amount']], where: range, group: ['status', 'resolution'], raw: true });
  else if (['products', 'variants', 'categories'].includes(report)) rows = await OrderItem.findAll({ attributes: ['productName', 'sku', [fn('SUM', col('quantity')), 'quantity'], [fn('COALESCE', fn('SUM', col('lineTotal')), 0), 'revenue'], [fn('COALESCE', fn('SUM', col('discountTotal')), 0), 'discount']], where: range, group: ['productName', 'sku'], order: [[fn('SUM', col('quantity')), 'DESC']], limit: 500, raw: true });
  else if (report === 'inventory' || report === 'low_stock') rows = await InventoryLevel.findAll({ include: [{ model: ProductVariant, as: 'variant', attributes: ['sku', 'title'] }], where: report === 'low_stock' ? { onHand: { [Op.lte]: col('lowStockThreshold') } } : {}, order: [['updatedAt', 'DESC']], limit: 1000 });
  else if (report === 'stock_movements') rows = await InventoryMovement.findAll({ where: range, order: [['createdAt', 'DESC']], limit: 1000 });
  else if (report === 'customers') rows = await User.findAll({ attributes: [[fn('DATE', col('createdAt')), 'date'], [fn('COUNT', col('id')), 'customers']], where: range, group: [fn('DATE', col('createdAt'))], raw: true });
  else if (report === 'coupons') rows = await CouponUsage.findAll({ attributes: ['couponId', 'status', [fn('COUNT', col('id')), 'uses'], [fn('COALESCE', fn('SUM', col('amount')), 0), 'discount']], where: range, group: ['couponId', 'status'], raw: true });
  else if (report === 'staff_activity') rows = await AuditLog.findAll({ attributes: ['actorId', 'action', [fn('COUNT', col('id')), 'count']], where: range, group: ['actorId', 'action'], order: [[fn('COUNT', col('id')), 'DESC']], raw: true });
  else throw AppError.notFound('Report not found.');
  return { report, summary, rows };
}

export async function listExports(query, requesterId) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = /** @type {any} */ ({ ...(query.mine === 'true' ? { requestedBy: requesterId } : {}), ...dateRange(query) });
  if (query.status) where.status = query.status;
  if (query.report) where.report = query.report;
  const result = await ExportJob.findAndCountAll({ where, include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }], limit, offset, order: [['createdAt', 'DESC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function createExport(payload, actorId, request) {
  const row = await ExportJob.create({ id: newId(), report: payload.report, filters: payload.filters || {}, status: 'queued', requestedBy: actorId });
  await addDomainEvent({ topic: 'export.requested', aggregateType: 'export_job', aggregateId: row.id, payload: { exportJobId: row.id, report: row.report }, transaction: null });
  await recordAudit({ actorId, action: 'export.request', resourceType: 'export_job', resourceId: row.id, after: { report: row.report, filters: row.filters }, request, transaction: null });
  return row;
}

export async function getExport(id) {
  const row = await ExportJob.findByPk(id, { include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }, { model: MediaAsset, as: 'file', required: false }] });
  if (!row) throw AppError.notFound('Export job not found.');
  const value = row.toJSON(); delete value.file;
  if (row.status === 'ready' && row.file) {
    const expires = Math.floor(Date.now() / 1000) + Math.min(env.MEDIA_PRIVATE_URL_TTL_SECONDS, 900);
    value.download = { url: `${env.API_BASE_PATH}/media/${row.file.id}/download?expires=${expires}&signature=${encodeURIComponent(signPrivateMedia(row.file.id, expires))}`, expiresAt: new Date(expires * 1000).toISOString() };
  } else value.download = null;
  return value;
}

export async function cancelExport(id, actorId, request) {
  const row = await ExportJob.findByPk(id);
  if (!row) throw AppError.notFound('Export job not found.');
  if (!['queued', 'processing'].includes(row.status)) throw AppError.conflict('EXPORT_NOT_CANCELLABLE', 'This export can no longer be cancelled.');
  await row.update({ status: 'failed', errorCode: 'CANCELLED_BY_USER' });
  await recordAudit({ actorId, action: 'export.cancel', resourceType: 'export_job', resourceId: row.id, request, transaction: null });
  return row;
}

function webhookDto(row) {
  return { id: row.id, name: row.name, topics: row.topics, url: row.url, status: row.status, failureCount: row.failureCount, version: Number(row.version), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function validateWebhookUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw AppError.unprocessable('WEBHOOK_HTTPS_REQUIRED', 'Webhook endpoints must use HTTPS.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^\[?::1\]?$/.test(host)) throw AppError.unprocessable('WEBHOOK_HOST_BLOCKED', 'Private and local webhook hosts are not allowed.');
  return url.toString();
}

export async function listWebhooks(query) {
  const rows = await Webhook.findAll({ paranoid: query.archived !== 'true', order: [['createdAt', 'DESC']] });
  return rows.map(webhookDto);
}

export async function saveWebhook(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    let row = id ? await Webhook.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (id && !row) throw AppError.notFound('Webhook not found.');
    if (row && Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'This webhook changed. Refresh and review it.');
    const before = row ? webhookDto(row) : null;
    const values = { name: payload.name, topics: [...new Set(payload.topics)], url: validateWebhookUrl(payload.url), status: payload.status, ...(payload.secret ? { encryptedSecret: encryptSecret({ secret: payload.secret }) } : {}) };
    if (!row && !payload.secret) throw AppError.unprocessable('WEBHOOK_SECRET_REQUIRED', 'A signing secret is required.');
    if (!row) row = await Webhook.create({ id: newId(), ...values, failureCount: 0, version: 1 }, { transaction });
    else await row.update({ ...values, version: row.version + 1 }, { transaction });
    await recordAudit({ actorId, action: id ? 'webhook.update' : 'webhook.create', resourceType: 'webhook', resourceId: row.id, before, after: webhookDto(row), request, transaction });
    return webhookDto(row);
  });
}

export async function listWebhookDeliveries(id, query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const result = await WebhookDelivery.findAndCountAll({ where: { webhookId: id }, attributes: { exclude: ['signature', 'requestBody'] }, limit, offset, order: [['createdAt', 'DESC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function retryWebhookDelivery(id, actorId, request) {
  const row = await WebhookDelivery.findByPk(id);
  if (!row) throw AppError.notFound('Webhook delivery not found.');
  if (!['retry', 'dead'].includes(row.status)) throw AppError.conflict('DELIVERY_NOT_RETRYABLE', 'Only failed webhook deliveries may be retried.');
  await row.update({ status: 'retry', nextAttemptAt: new Date(), errorCode: null });
  await recordAudit({ actorId, action: 'webhook.delivery_retry', resourceType: 'webhook_delivery', resourceId: row.id, request, transaction: null });
  return row;
}

export async function rotateWebhookSecret(id, secret, version, actorId, request) {
  const row = await Webhook.findByPk(id);
  if (!row) throw AppError.notFound('Webhook not found.');
  if (Number(version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'This webhook changed. Refresh and review it.');
  await row.update({ encryptedSecret: encryptSecret({ secret }), version: row.version + 1 });
  await recordAudit({ actorId, action: 'webhook.secret_rotate', resourceType: 'webhook', resourceId: row.id, request, transaction: null });
  return webhookDto(row);
}

export async function archiveWebhook(id, actorId, request) {
  const row = await Webhook.findByPk(id);
  if (!row) throw AppError.notFound('Webhook not found.');
  await row.destroy();
  await recordAudit({ actorId, action: 'webhook.archive', resourceType: 'webhook', resourceId: row.id, request, transaction: null });
}

export async function testWebhook(id, actorId, request) {
  const webhook = await Webhook.findByPk(id);
  if (!webhook) throw AppError.notFound('Webhook not found.');
  const event = await OutboxEvent.create({ id: newId(), topic: 'webhook.test', aggregateType: 'webhook', aggregateId: webhook.id, payload: { test: true, webhookId: id }, status: 'processing', attempts: 0, availableAt: new Date() });
  const delivery = await deliverWebhook(webhook, event);
  await event.update({ status: delivery.status === 'success' ? 'published' : 'failed', attempts: 1, processedAt: delivery.status === 'success' ? new Date() : null, availableAt: delivery.nextAttemptAt || event.availableAt });
  await recordAudit({ actorId, action: 'webhook.test', resourceType: 'webhook', resourceId: webhook.id, metadata: { deliveryId: delivery.id, status: delivery.status }, request, transaction: null });
  return delivery;
}

export async function listContactMessages(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = { ...dateRange(query) };
  if (query.status) where.status = query.status;
  const result = await ContactMessage.findAndCountAll({ where, limit, offset, order: [['createdAt', 'DESC']] });
  return pageEnvelope(result, page, pageSize);
}

export async function updateContactMessage(id, status, actorId, request) {
  const row = await ContactMessage.findByPk(id);
  if (!row) throw AppError.notFound('Contact message not found.');
  const before = { status: row.status };
  await row.update({ status });
  await recordAudit({ actorId, action: 'contact.status_update', resourceType: 'contact_message', resourceId: row.id, before, after: { status }, request, transaction: null });
  return row;
}
