import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { Op } from 'sequelize';
import {
  AuditLog, CheckoutQuote, Coupon, ExportJob, IdempotencyRecord, IntegrationCredential,
  InventoryLevel, InventoryMovement, InventoryReservation, MediaAsset, NotificationOutbox,
  NotificationTemplate, Order, OutboxEvent, Page, Payment, PaymentAttempt, Post, Product,
  ReturnRequest, User, Webhook, WebhookDelivery,
} from '../db/models.js';
import { sequelize } from '../db/sequelize.js';
import { decryptSecret } from '../lib/encryption.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { persistOriginal } from '../modules/media/media.storage.js';

const maxAttempts = 8;
const delayFor = (attempt) => Math.min(6 * 60 * 60 * 1000, (2 ** Math.max(0, attempt - 1)) * 30_000 + Math.floor(Math.random() * 10_000));

export function renderTemplate(template, payload) {
  const allowed = new Set(template.variables || []);
  const replace = (input) => String(input || '').replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (_, key) => {
    if (!allowed.has(key) || payload[key] == null) throw new Error(`Missing or disallowed template variable: ${key}`);
    return String(payload[key]);
  });
  return { subject: template.subject ? replace(template.subject) : null, body: replace(template.body) };
}

async function failNotification(row, error) {
  const attempts = Number(row.attempts) + 1;
  await row.update({ attempts, status: attempts >= maxAttempts ? 'dead' : 'retry', scheduledAt: new Date(Date.now() + delayFor(attempts)), errorCode: error.code || 'DELIVERY_FAILED', lastError: String(error.message || error).slice(0, 500) });
}

async function sendEmail(recipient, subject, body) {
  const credential = await IntegrationCredential.findOne({ where: { provider: 'smtp', active: true }, order: [['updatedAt', 'DESC']] });
  if (!credential) throw Object.assign(new Error('SMTP is not configured.'), { code: 'SMTP_NOT_CONFIGURED' });
  const config = decryptSecret(credential.encryptedPayload);
  const transport = nodemailer.createTransport({ host: config.host, port: Number(config.port), secure: Boolean(config.secure), auth: config.username ? { user: config.username, pass: config.password } : undefined, connectionTimeout: 8000, socketTimeout: 12000 });
  const result = await transport.sendMail({ from: config.from, to: recipient, subject: subject || 'Elite Emporium update', text: body });
  return result.messageId;
}

function privateAddress(address) {
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:');
}

async function assertPublicHost(urlValue) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password) throw Object.assign(new Error('Integration URL must use HTTPS without credentials.'), { code: 'UNSAFE_INTEGRATION_URL' });
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw Object.assign(new Error('Integration URL resolved to a blocked address.'), { code: 'UNSAFE_INTEGRATION_HOST' });
  return url;
}

async function sendSms(recipient, body) {
  const credential = await IntegrationCredential.findOne({ where: { provider: 'sms', active: true }, order: [['updatedAt', 'DESC']] });
  if (!credential) throw Object.assign(new Error('SMS is not configured.'), { code: 'SMS_NOT_CONFIGURED' });
  const config = decryptSecret(credential.encryptedPayload); const url = await assertPublicHost(config.url);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', ...(config.token ? { [config.tokenHeader || 'authorization']: config.tokenScheme ? `${config.tokenScheme} ${config.token}` : config.token } : {}) }, body: JSON.stringify({ [config.recipientField || 'to']: recipient, [config.messageField || 'message']: body }) });
  if (!response.ok) throw Object.assign(new Error(`SMS provider returned ${response.status}.`), { code: 'SMS_PROVIDER_ERROR' });
  return response.headers.get('x-message-id') || null;
}

export async function processNotifications(limit = 20) {
  const rows = await NotificationOutbox.findAll({ where: { status: { [Op.in]: ['pending', 'retry'] }, scheduledAt: { [Op.lte]: new Date() } }, order: [['scheduledAt', 'ASC']], limit });
  for (const row of rows) {
    try {
      const claimed = await NotificationOutbox.update({ status: 'processing' }, { where: { id: row.id, status: { [Op.in]: ['pending', 'retry'] } } });
      if (!claimed[0]) continue;
      const template = row.templateId ? await NotificationTemplate.findByPk(row.templateId) : await NotificationTemplate.findOne({ where: { event: row.event, channel: row.channel, locale: row.locale, active: true } });
      const rendered = template ? renderTemplate(template, row.payload || {}) : { subject: row.payload?.subject || null, body: row.payload?.message || String(row.event) };
      let providerMessageId = null;
      if (row.channel === 'email') providerMessageId = await sendEmail(row.recipient, rendered.subject, rendered.body);
      if (row.channel === 'sms') providerMessageId = await sendSms(row.recipient, rendered.body);
      await row.update({ renderedSubject: rendered.subject, renderedBody: rendered.body, providerMessageId, status: 'sent', attempts: Number(row.attempts) + 1, sentAt: new Date(), errorCode: null, lastError: null });
    } catch (error) { await failNotification(row, error); logger.warn({ err: error, jobId: row.id, job: 'notification.delivery' }, 'Notification delivery failed'); }
  }
  return rows.length;
}

function csvCell(value) { const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return `"${text.replaceAll('"', '""')}"`; }
async function reportRows(report, filters) {
  const range = filters?.from || filters?.to ? { createdAt: { ...(filters.from ? { [Op.gte]: new Date(filters.from) } : {}), ...(filters.to ? { [Op.lt]: new Date(filters.to) } : {}) } } : {};
  const models = { orders: Order, sales: Order, products: Product, inventory: InventoryLevel, customers: User, coupons: Coupon, payments: Payment, returns: ReturnRequest, profit: Order, audits: AuditLog };
  const Model = models[report]; if (!Model) throw Object.assign(new Error('Unsupported report.'), { code: 'UNSUPPORTED_REPORT' });
  return Model.findAll({ where: range, raw: true, limit: 100_000, order: [['createdAt', 'ASC']] });
}

export async function processExports(limit = 5) {
  const jobs = await ExportJob.findAll({ where: { status: 'queued' }, order: [['createdAt', 'ASC']], limit });
  for (const job of jobs) {
    try {
      const claimed = await ExportJob.update({ status: 'processing' }, { where: { id: job.id, status: 'queued' } }); if (!claimed[0]) continue;
      const rows = await reportRows(job.report, job.filters || {}); const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const csv = `${columns.map(csvCell).join(',')}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\n')}\n`;
      const buffer = Buffer.from(csv, 'utf8'); const stored = await persistOriginal({ buffer, privacy: 'private', extension: 'csv' });
      const asset = await MediaAsset.create({ id: newId(), uploaderId: job.requestedBy, storageKey: stored.storageKey, originalName: `${job.report}-${job.id}.csv`, kind: 'document', mimeType: 'text/csv', byteSize: buffer.length, checksum: stored.checksum, privacy: 'private', status: 'ready', metadata: { purpose: 'export', report: job.report } });
      await job.update({ status: 'ready', mediaId: asset.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), errorCode: null });
    } catch (error) { await job.update({ status: 'failed', errorCode: error.code || 'EXPORT_FAILED' }); logger.error({ err: error, jobId: job.id, job: 'export.generate' }, 'Export failed'); }
  }
  return jobs.length;
}

export async function deliverWebhook(webhook, event) {
  let delivery = await WebhookDelivery.findOne({ where: { webhookId: webhook.id, eventId: event.id } });
  if (delivery?.status === 'success' || delivery?.status === 'dead') return delivery;
  if (!delivery) delivery = await WebhookDelivery.create({ id: newId(), webhookId: webhook.id, eventId: event.id, attempt: 0, status: 'pending', requestBody: { id: event.id, topic: event.topic, createdAt: event.createdAt, data: event.payload } });
  const body = JSON.stringify(delivery.requestBody); const { secret } = decryptSecret(webhook.encryptedSecret); const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`; const started = Date.now();
  try {
    const url = await assertPublicHost(webhook.url); const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', 'user-agent': 'Elite-Emporium-Webhook/1.0', 'x-ee-event': event.topic, 'x-ee-delivery': delivery.id, 'x-ee-signature': signature }, body });
    if (!response.ok) throw Object.assign(new Error(`Endpoint returned ${response.status}.`), { code: 'WEBHOOK_HTTP_ERROR', responseCode: response.status });
    await delivery.update({ attempt: Number(delivery.attempt) + 1, signature, status: 'success', responseCode: response.status, durationMs: Date.now() - started, responseExcerpt: (await response.text()).slice(0, 1000), errorCode: null, nextAttemptAt: null });
    await webhook.update({ failureCount: 0 });
  } catch (error) {
    const attempt = Number(delivery.attempt) + 1; await delivery.update({ attempt, signature, status: attempt >= maxAttempts ? 'dead' : 'retry', responseCode: error.responseCode || null, durationMs: Date.now() - started, errorCode: error.code || 'WEBHOOK_FAILED', nextAttemptAt: new Date(Date.now() + delayFor(attempt)) });
    await webhook.update({ failureCount: Number(webhook.failureCount) + 1 });
  }
  return delivery;
}

export async function processWebhooks(limit = 20) {
  const events = await OutboxEvent.findAll({ where: { status: { [Op.in]: ['pending', 'failed'] }, availableAt: { [Op.lte]: new Date() } }, order: [['availableAt', 'ASC']], limit });
  const hooks = await Webhook.findAll({ where: { status: 'active' } });
  for (const event of events) {
    const targets = hooks.filter((hook) => (hook.topics || []).includes(event.topic) || (hook.topics || []).includes('*'));
    const deliveries = [];
    for (const hook of targets) deliveries.push(await deliverWebhook(hook, event));
    const retryAt = deliveries.filter((item) => item.status === 'retry').map((item) => item.nextAttemptAt).sort()[0];
    await event.update({ status: retryAt ? 'failed' : 'published', attempts: Number(event.attempts) + 1, availableAt: retryAt || event.availableAt, processedAt: retryAt ? null : new Date() });
  }
  return events.length;
}

export async function processScheduledPublishing() {
  const now = new Date();
  const [products, pages, posts] = await sequelize.transaction(async (transaction) => Promise.all([
    Product.update({ status: 'published', publishedAt: now, publishAt: null }, { where: { status: 'scheduled', publishAt: { [Op.lte]: now } }, transaction }),
    Page.update({ status: 'published' }, { where: { status: 'scheduled', publishAt: { [Op.lte]: now } }, transaction }),
    Post.update({ status: 'published' }, { where: { status: 'scheduled', publishAt: { [Op.lte]: now } }, transaction }),
  ]));
  return Number(products[0]) + Number(pages[0]) + Number(posts[0]);
}

export async function releaseExpiredReservations(limit = 100) {
  const candidates = await InventoryReservation.findAll({ where: { status: 'active', expiresAt: { [Op.lte]: new Date() } }, order: [['expiresAt', 'ASC']], limit });
  let released = 0;
  for (const candidate of candidates) {
    const didRelease = await sequelize.transaction(async (transaction) => {
      const reservation = await InventoryReservation.findOne({ where: { id: candidate.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
      if (!reservation) return false;
      const level = await InventoryLevel.findOne({ where: { variantId: reservation.variantId, locationId: reservation.locationId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!level) throw new Error(`Inventory level missing for reservation ${reservation.id}`);
      const beforeReserved = Number(level.reserved); const nextReserved = Math.max(0, beforeReserved - Number(reservation.quantity));
      await level.update({ reserved: nextReserved, version: Number(level.version) + 1 }, { transaction });
      await reservation.update({ status: 'expired', releasedAt: new Date() }, { transaction });
      await InventoryMovement.create({ id: newId(), variantId: reservation.variantId, locationId: reservation.locationId, orderId: reservation.orderId, quantityDelta: 0, reservedDelta: -Number(reservation.quantity), onHandBefore: Number(level.onHand), balanceAfter: Number(level.onHand), reservedAfter: nextReserved, reason: 'reservation_expired', correlationId: reservation.id }, { transaction });
      if (reservation.orderId) {
        await PaymentAttempt.update({ status: 'expired' }, { where: { status: { [Op.in]: ['created', 'redirected'] }, expiresAt: { [Op.lte]: new Date() } }, transaction });
        await Order.update({ orderStatus: 'failed', paymentStatus: 'failed' }, { where: { id: reservation.orderId, orderStatus: 'pending_payment' }, transaction });
      }
      return true;
    });
    if (didRelease) released += 1;
  }
  return released;
}

export async function processRetentionCleanup() {
  const now = new Date();
  const [quotes, keys, exports] = await Promise.all([
    CheckoutQuote.destroy({ where: { expiresAt: { [Op.lt]: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }),
    IdempotencyRecord.destroy({ where: { expiresAt: { [Op.lt]: now } } }),
    ExportJob.update({ status: 'expired' }, { where: { status: 'ready', expiresAt: { [Op.lt]: now } } }),
  ]);
  return { quotes, idempotencyKeys: keys, exports: exports[0] };
}

export async function runJobsOnce() {
  if (!sequelize) return;
  const [notifications, exports, webhooks, publishing, reservations, cleanup] = await Promise.all([processNotifications(), processExports(), processWebhooks(), processScheduledPublishing(), releaseExpiredReservations(), processRetentionCleanup()]);
  return { notifications, exports, webhooks, publishing, reservations, cleanup };
}
