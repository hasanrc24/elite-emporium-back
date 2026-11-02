import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { Op } from "sequelize";
import {
  AuditLog,
  CheckoutQuote,
  Coupon,
  CouponUsage,
  ExportJob,
  IdempotencyRecord,
  IntegrationCredential,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  MediaAsset,
  NotificationOutbox,
  NotificationTemplate,
  Order,
  OrderEvent,
  OutboxEvent,
  Page,
  Payment,
  PaymentAttempt,
  Post,
  Product,
  ReturnRequest,
  Review,
  User,
  UserAddress,
  Webhook,
  WebhookDelivery,
} from "../db/models.js";
import { sequelize } from "../db/sequelize.js";
import { decryptSecret } from "../lib/encryption.js";
import { newId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { dateRangeWhere } from "../lib/date-range.js";
import { publishDueProducts } from "../modules/catalog/admin-product.service.js";
import { addDomainEvent } from "../modules/events/outbox.service.js";
import {
  deliverStaffNotification,
  notifyStaff,
  notifyStaffMember,
  purgeStaffNotifications,
} from "../modules/notifications/staff-notification.service.js";
import { persistOriginal } from "../modules/media/media.storage.js";
import { expireStaleManualPayments } from "../modules/payments/manual-payment.service.js";
import {
  processMetaCapiQueue,
  purgeMetaCapiEvents,
} from "../modules/tracking/meta-capi.service.js";
import { cancelStaleUnconfirmedOrders } from "../modules/orders/confirmation.service.js";
import {
  assertPublicHostname,
  postToPublicUrl,
} from "../modules/integrations/outbound.js";

const maxAttempts = 8;
const claimLeaseMs = 15 * 60 * 1000;
const delayFor = (attempt: RuntimeValue) =>
  Math.min(
    6 * 60 * 60 * 1000,
    2 ** Math.max(0, attempt - 1) * 30_000 + Math.floor(Math.random() * 10_000),
  );

export function renderTemplate(template: RuntimeValue, payload: RuntimeValue) {
  const allowed = new Set(template.variables || []);
  const replace = (input: RuntimeValue) =>
    String(input || "").replace(
      /{{\s*([A-Za-z0-9_.-]+)\s*}}/g,
      (_: RuntimeValue, key: RuntimeValue) => {
        if (!allowed.has(key) || payload[key] == null)
          // Re-sending cannot supply the variable, so fail without retrying.
          throw Object.assign(
            new Error(`Missing or disallowed template variable: ${key}`),
            { code: "TEMPLATE_VARIABLE_MISSING", permanent: true },
          );
        return String(payload[key]);
      },
    );
  return {
    subject: template.subject ? replace(template.subject) : null,
    body: replace(template.body),
  };
}

async function failNotification(row: RuntimeValue, error: RuntimeValue) {
  const attempts = Number(row.attempts) + 1;
  const dead = error.permanent || attempts >= maxAttempts;
  await row.update({
    attempts,
    status: dead ? "dead" : "retry",
    scheduledAt: new Date(Date.now() + delayFor(attempts)),
    errorCode: error.code || "DELIVERY_FAILED",
    lastError: String(error.message || error).slice(0, 500),
  });
  // Dashboard rows are excluded so a broken inbox cannot alert about itself.
  if (dead && row.channel !== "dashboard")
    await notifyStaff("platform", {
      event: "notification.delivery_failed",
      title: `${row.channel === "sms" ? "SMS" : "Email"} delivery failed`,
      message: `${row.event} could not be delivered (${error.code || "DELIVERY_FAILED"}). Check the integration, then retry it from the delivery outbox.`,
      link: "/admin/notification-deliveries?status=dead",
      severity: "critical",
      dedupeKey: "notification.delivery_failed",
      data: { deliveryId: row.id, channel: row.channel },
    });
}

async function sendEmail(
  recipient: RuntimeValue,
  subject: RuntimeValue,
  body: RuntimeValue,
) {
  const credential: RuntimeValue = await IntegrationCredential.findOne({
    where: { provider: "smtp", active: true },
    order: [["updatedAt", "DESC"]],
  });
  if (!credential)
    throw Object.assign(new Error("SMTP is not configured."), {
      code: "SMTP_NOT_CONFIGURED",
    });
  const config: RuntimeValue = decryptSecret(credential.encryptedPayload);
  await assertPublicHostname(String(config.host || ""));
  const transport: RuntimeValue = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: Boolean(config.secure),
    auth: config.username
      ? { user: config.username, pass: config.password }
      : undefined,
    connectionTimeout: 8000,
    socketTimeout: 12000,
  });
  const result: RuntimeValue = await transport.sendMail({
    from: config.from,
    to: recipient,
    subject: subject || "Elite Emporium update",
    text: body,
  });
  return result.messageId;
}

async function sendSms(recipient: RuntimeValue, body: RuntimeValue) {
  const credential: RuntimeValue = await IntegrationCredential.findOne({
    where: { provider: "sms", active: true },
    order: [["updatedAt", "DESC"]],
  });
  if (!credential)
    throw Object.assign(new Error("SMS is not configured."), {
      code: "SMS_NOT_CONFIGURED",
    });
  const config: RuntimeValue = decryptSecret(credential.encryptedPayload);
  const response: RuntimeValue = await postToPublicUrl(
    config.url,
    {
      "content-type": "application/json",
      ...(config.token
        ? {
            [config.tokenHeader || "authorization"]: config.tokenScheme
              ? `${config.tokenScheme} ${config.token}`
              : config.token,
          }
        : {}),
    },
    JSON.stringify({
      [config.recipientField || "to"]: recipient,
      [config.messageField || "message"]: body,
    }),
  );
  if (!response.ok)
    throw Object.assign(
      new Error(`SMS provider returned ${response.status}.`),
      { code: "SMS_PROVIDER_ERROR" },
    );
  const messageId = response.headers["x-message-id"];
  return (Array.isArray(messageId) ? messageId[0] : messageId) || null;
}

async function processNotifications(limit: RuntimeValue = 20) {
  const rows: RuntimeValue = await NotificationOutbox.findAll({
    where: {
      status: { [Op.in]: ["pending", "retry"] },
      scheduledAt: { [Op.lte]: new Date() },
    },
    order: [["scheduledAt", "ASC"]],
    limit,
  });
  for (const row of rows) {
    try {
      // The claim re-checks the due time so a row another worker already
      // rescheduled into the future is not sent early.
      const claimed: RuntimeValue = await NotificationOutbox.update(
        { status: "processing" },
        {
          where: {
            id: row.id,
            status: { [Op.in]: ["pending", "retry"] },
            scheduledAt: { [Op.lte]: new Date() },
          },
        },
      );
      if (!claimed[0]) continue;
      await row.reload();
      const configured: RuntimeValue = row.templateId
        ? await NotificationTemplate.findByPk(row.templateId)
        : await NotificationTemplate.findOne({
            where: {
              event: row.event,
              channel: row.channel,
              locale: row.locale,
            },
          });
      // Deactivating a dashboard template is the trigger switch for that
      // staff alert (BR-NOTIFY-001); an explicit test send still renders.
      if (
        row.channel === "dashboard" &&
        !row.templateId &&
        configured &&
        !configured.active
      ) {
        await row.update({
          status: "skipped",
          attempts: Number(row.attempts) + 1,
          errorCode: "TRIGGER_DISABLED",
          lastError: null,
        });
        continue;
      }
      const template: RuntimeValue =
        row.templateId || configured?.active ? configured : null;
      // Auth flows keep OTPs and reset links in an encrypted `secure` field;
      // decrypt it only for rendering and never persist the rendered text.
      const { secure, ...publicPayload }: RuntimeValue = row.payload || {};
      let variables: RuntimeValue = publicPayload;
      if (secure) {
        try {
          variables = { ...publicPayload, ...decryptSecret(secure) };
        } catch {
          throw Object.assign(
            new Error("Notification secure payload cannot be decrypted."),
            { code: "SECURE_PAYLOAD_INVALID", permanent: true },
          );
        }
      }
      const rendered: RuntimeValue = template
        ? renderTemplate(template, variables)
        : {
            subject: row.payload?.subject || null,
            body: row.payload?.message || String(row.event),
          };
      let providerMessageId = null;
      if (row.channel === "email")
        providerMessageId = await sendEmail(
          row.recipient,
          rendered.subject,
          rendered.body,
        );
      if (row.channel === "sms")
        providerMessageId = await sendSms(row.recipient, rendered.body);
      if (row.channel === "dashboard")
        providerMessageId = `staff:${await deliverStaffNotification(row, rendered)}`;
      // Column limits: an over-long value would fail this update after the
      // message was delivered and cause it to be re-sent on every retry.
      await row.update({
        renderedSubject:
          secure || rendered.subject == null
            ? null
            : String(rendered.subject).slice(0, 255),
        renderedBody: secure ? null : rendered.body,
        providerMessageId:
          providerMessageId == null
            ? null
            : String(providerMessageId).slice(0, 190),
        status: "sent",
        attempts: Number(row.attempts) + 1,
        sentAt: new Date(),
        errorCode: null,
        lastError: null,
      });
    } catch (error: RuntimeValue) {
      logger.warn(
        { err: error, jobId: row.id, job: "notification.delivery" },
        "Notification delivery failed",
      );
      await failNotification(row, error).catch((failure: RuntimeValue) =>
        logger.error(
          { err: failure, jobId: row.id, job: "notification.delivery" },
          "Notification failure could not be recorded",
        ),
      );
    }
  }
  return rows.length;
}

/** Requeues work abandoned by a worker that exited after claiming a row. */
export async function recoverStaleJobs(now: RuntimeValue = new Date()) {
  const staleBefore = new Date(now.getTime() - claimLeaseMs);
  const [notifications, exports, events, deliveries]: RuntimeValue =
    await Promise.all([
      NotificationOutbox.update(
        {
          status: "retry",
          scheduledAt: now,
          errorCode: "STALE_CLAIM_RECOVERED",
        },
        {
          where: { status: "processing", updatedAt: { [Op.lt]: staleBefore } },
        },
      ),
      ExportJob.update(
        { status: "queued", errorCode: "STALE_CLAIM_RECOVERED" },
        {
          where: { status: "processing", updatedAt: { [Op.lt]: staleBefore } },
        },
      ),
      OutboxEvent.update(
        { status: "failed", availableAt: now },
        {
          where: { status: "processing", updatedAt: { [Op.lt]: staleBefore } },
        },
      ),
      WebhookDelivery.update(
        { nextAttemptAt: now },
        {
          where: {
            status: "retry",
            nextAttemptAt: null,
            updatedAt: { [Op.lt]: staleBefore },
          },
        },
      ),
    ]);
  return {
    notifications: notifications[0],
    exports: exports[0],
    webhookEvents: events[0],
    webhookDeliveries: deliveries[0],
  };
}

function csvCell(value: RuntimeValue) {
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
/** One customer's own data for an approved privacy (access) request. */
async function privacyExportRows(filters: RuntimeValue) {
  const userId = String(filters?.userId || "");
  if (!userId)
    throw Object.assign(new Error("Privacy export has no customer."), {
      code: "PRIVACY_EXPORT_INVALID",
    });
  const where = { userId };
  const [user, addresses, orders, reviews, returns]: RuntimeValue =
    await Promise.all([
      User.findByPk(userId, {
        attributes: { exclude: ["passwordHash"] },
        paranoid: false,
        raw: true,
      }),
      UserAddress.findAll({ where, raw: true }),
      Order.findAll({ where, raw: true, order: [["createdAt", "ASC"]] }),
      Review.findAll({ where, raw: true, order: [["createdAt", "ASC"]] }),
      ReturnRequest.findAll({
        where,
        raw: true,
        order: [["createdAt", "ASC"]],
      }),
    ]);
  if (!user)
    throw Object.assign(new Error("Privacy export customer not found."), {
      code: "PRIVACY_EXPORT_INVALID",
    });
  const section = (name: string, rows: RuntimeValue[]) =>
    rows.map((row: RuntimeValue) => ({ section: name, ...row }));
  return [
    { section: "profile", ...user },
    ...section("address", addresses),
    ...section("order", orders),
    ...section("review", reviews),
    ...section("return", returns),
  ];
}

async function reportRows(report: RuntimeValue, filters: RuntimeValue) {
  if (report === "customer_privacy_export") return privacyExportRows(filters);
  const range: RuntimeValue = dateRangeWhere(filters);
  const models: RuntimeValue = {
    orders: Order,
    sales: Order,
    products: Product,
    inventory: InventoryLevel,
    customers: User,
    coupons: Coupon,
    payments: Payment,
    returns: ReturnRequest,
    profit: Order,
    audits: AuditLog,
  };
  const Model = models[report];
  if (!Model)
    throw Object.assign(new Error("Unsupported report."), {
      code: "UNSUPPORTED_REPORT",
    });
  return Model.findAll({
    where: range,
    // Credential hashes never leave the database, even in staff exports.
    ...(Model === User ? { attributes: { exclude: ["passwordHash"] } } : {}),
    raw: true,
    limit: 100_000,
    order: [["createdAt", "ASC"]],
  });
}

async function notifyExportOutcome(job: RuntimeValue, ready: boolean) {
  if (!job.requestedBy) return null;
  const privacy = Boolean(job.privacyRequestId);
  const report = privacy
    ? "privacy data"
    : String(job.report).replaceAll("_", " ");
  return notifyStaffMember(
    job.requestedBy,
    privacy ? "customers.view" : "reports.view",
    {
      event: ready ? "export.ready" : "export.failed",
      title: ready
        ? `Your ${report} export is ready`
        : `Your ${report} export failed`,
      message: ready
        ? `Download it from ${privacy ? "Privacy requests" : "Exports"} within 24 hours.`
        : "Try creating the export again. Contact support if it keeps failing.",
      link: privacy ? "/admin/privacy-requests" : "/admin/exports",
      severity: ready ? "success" : "warning",
      data: { exportId: job.id, report: job.report },
    },
  );
}

async function processExports(limit: RuntimeValue = 5) {
  const jobs: RuntimeValue = await ExportJob.findAll({
    where: { status: "queued" },
    order: [["createdAt", "ASC"]],
    limit,
  });
  for (const job of jobs) {
    try {
      const claimed: RuntimeValue = await ExportJob.update(
        { status: "processing" },
        { where: { id: job.id, status: "queued" } },
      );
      if (!claimed[0]) continue;
      const rows: RuntimeValue = await reportRows(
        job.report,
        job.filters || {},
      );
      const columns: RuntimeValue = [
        ...new Set(rows.flatMap((row: RuntimeValue) => Object.keys(row))),
      ];
      const csv = `${columns.map(csvCell).join(",")}\n${rows.map((row: RuntimeValue) => columns.map((column: RuntimeValue) => csvCell(row[column])).join(",")).join("\n")}\n`;
      const buffer: RuntimeValue = Buffer.from(csv, "utf8");
      const stored: RuntimeValue = await persistOriginal({
        buffer,
        privacy: "private",
        extension: "csv",
      });
      const asset: RuntimeValue = await MediaAsset.create({
        id: newId(),
        uploaderId: job.requestedBy,
        storageKey: stored.storageKey,
        originalName: `${job.report}-${job.id}.csv`,
        kind: "document",
        mimeType: "text/csv",
        byteSize: buffer.length,
        checksum: stored.checksum,
        privacy: "private",
        status: "ready",
        metadata: { purpose: "export", report: job.report },
      });
      await job.update({
        status: "ready",
        mediaId: asset.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        errorCode: null,
      });
      await notifyExportOutcome(job, true).catch((error: RuntimeValue) =>
        logger.warn(
          { err: error, jobId: job.id, job: "export.generate" },
          "Export alert could not be queued",
        ),
      );
    } catch (error: RuntimeValue) {
      await ExportJob.update(
        {
          status: "failed",
          errorCode: String(error.code || "EXPORT_FAILED").slice(0, 100),
        },
        { where: { id: job.id } },
      ).catch(() => undefined);
      logger.error(
        { err: error, jobId: job.id, job: "export.generate" },
        "Export failed",
      );
      await notifyExportOutcome(job, false).catch(() => undefined);
    }
  }
  return jobs.length;
}

export async function deliverWebhook(
  webhook: RuntimeValue,
  event: RuntimeValue,
) {
  let delivery: RuntimeValue = await WebhookDelivery.findOne({
    where: { webhookId: webhook.id, eventId: event.id },
  });
  if (delivery?.status === "success" || delivery?.status === "dead")
    return delivery;
  // Each endpoint keeps its own backoff even when the shared event is due.
  if (
    delivery?.status === "retry" &&
    delivery.nextAttemptAt &&
    new Date(delivery.nextAttemptAt).getTime() > Date.now()
  )
    return delivery;
  if (!delivery)
    delivery = await WebhookDelivery.create({
      id: newId(),
      webhookId: webhook.id,
      eventId: event.id,
      attempt: 0,
      status: "pending",
      requestBody: {
        id: event.id,
        topic: event.topic,
        createdAt: event.createdAt,
        data: event.payload,
      },
    });
  const body: RuntimeValue = JSON.stringify(delivery.requestBody);
  let signature: RuntimeValue = delivery.signature || null;
  const started: RuntimeValue = Date.now();
  try {
    // Decrypting inside the try records an unreadable secret as a failed
    // delivery instead of aborting the whole webhook batch.
    const { secret }: RuntimeValue = decryptSecret(webhook.encryptedSecret);
    signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response: RuntimeValue = await postToPublicUrl(
      webhook.url,
      {
        "content-type": "application/json",
        "user-agent": "Elite-Emporium-Webhook/1.0",
        "x-ee-event": event.topic,
        "x-ee-delivery": delivery.id,
        "x-ee-signature": signature,
      },
      body,
    );
    if (!response.ok)
      throw Object.assign(new Error(`Endpoint returned ${response.status}.`), {
        code: "WEBHOOK_HTTP_ERROR",
        responseCode: response.status,
      });
    await delivery.update({
      attempt: Number(delivery.attempt) + 1,
      signature,
      status: "success",
      responseCode: response.status,
      durationMs: Date.now() - started,
      responseExcerpt: response.text.slice(0, 1000),
      errorCode: null,
      nextAttemptAt: null,
    });
    await webhook.update({ failureCount: 0 });
  } catch (error: RuntimeValue) {
    const attempt = Number(delivery.attempt) + 1;
    const dead = attempt >= maxAttempts;
    await delivery.update({
      attempt,
      signature,
      status: dead ? "dead" : "retry",
      responseCode: error.responseCode || null,
      durationMs: Date.now() - started,
      errorCode: String(error.code || "WEBHOOK_FAILED").slice(0, 100),
      nextAttemptAt: dead ? null : new Date(Date.now() + delayFor(attempt)),
    });
    await webhook.update({ failureCount: Number(webhook.failureCount) + 1 });
    if (dead)
      await notifyStaff("webhooks", {
        event: "webhook.delivery_failed",
        title: `Webhook "${webhook.name}" is failing`,
        message: `${event.topic} could not be delivered after ${attempt} attempts (${String(error.code || "WEBHOOK_FAILED")}).`,
        link: "/admin/webhooks",
        severity: "critical",
        dedupeKey: `webhook.delivery_failed:${webhook.id}`,
        data: { webhookId: webhook.id, deliveryId: delivery.id },
      }).catch((failure: RuntimeValue) =>
        logger.warn(
          { err: failure, webhookId: webhook.id, job: "webhook" },
          "Webhook failure alert could not be queued",
        ),
      );
  }
  return delivery;
}

async function deliverSafely(webhook: RuntimeValue, event: RuntimeValue) {
  try {
    return await deliverWebhook(webhook, event);
  } catch (error: RuntimeValue) {
    logger.error(
      { err: error, jobId: event.id, webhookId: webhook.id, job: "webhook" },
      "Webhook delivery could not be recorded",
    );
    return {
      status: "retry",
      nextAttemptAt: new Date(Date.now() + delayFor(1)),
    };
  }
}

async function processWebhooks(limit: RuntimeValue = 20) {
  const now = new Date();
  const events: RuntimeValue = await OutboxEvent.findAll({
    where: {
      status: { [Op.in]: ["pending", "failed"] },
      availableAt: { [Op.lte]: now },
    },
    order: [["availableAt", "ASC"]],
    limit,
  });
  const hooks: RuntimeValue = await Webhook.findAll({
    where: { status: "active" },
  });
  let processed = 0;
  for (const event of events) {
    // Atomic claim: concurrent workers must not deliver the same event twice.
    const [claimed]: RuntimeValue = await OutboxEvent.update(
      { status: "processing" },
      {
        where: {
          id: event.id,
          status: event.status,
          availableAt: { [Op.lte]: now },
        },
      },
    );
    if (!claimed) continue;
    processed += 1;
    // Test events belong to the single webhook that requested them.
    const targets: RuntimeValue = hooks.filter((hook: RuntimeValue) =>
      event.topic === "webhook.test"
        ? hook.id === event.aggregateId
        : (hook.topics || []).includes(event.topic) ||
          (hook.topics || []).includes("*"),
    );
    const deliveries: RuntimeValue = [];
    for (const hook of targets)
      deliveries.push(await deliverSafely(hook, event));
    const retryAt: RuntimeValue = deliveries
      .filter((item: RuntimeValue) => item.status === "retry")
      .map((item: RuntimeValue) => new Date(item.nextAttemptAt).getTime())
      .filter((time: number) => Number.isFinite(time))
      .sort((a: number, b: number) => a - b)[0];
    await OutboxEvent.update(
      {
        status: retryAt ? "failed" : "published",
        attempts: Number(event.attempts) + 1,
        availableAt: retryAt ? new Date(retryAt) : event.availableAt,
        processedAt: retryAt ? null : new Date(),
      },
      { where: { id: event.id } },
    );
  }
  // Manual retries (and retries left behind once an event was published) are
  // driven by the delivery row, since the event is no longer polled.
  const due: RuntimeValue = await WebhookDelivery.findAll({
    where: { status: "retry", nextAttemptAt: { [Op.lte]: now } },
    include: [
      {
        model: OutboxEvent,
        as: "event",
        required: true,
        where: { status: "published" },
      },
    ],
    order: [["nextAttemptAt", "ASC"]],
    limit,
  });
  for (const delivery of due) {
    const hook: RuntimeValue = hooks.find(
      (item: RuntimeValue) => item.id === delivery.webhookId,
    );
    if (!hook) continue;
    const [claimed]: RuntimeValue = await WebhookDelivery.update(
      { nextAttemptAt: null },
      {
        where: {
          id: delivery.id,
          status: "retry",
          nextAttemptAt: { [Op.lte]: now },
        },
      },
    );
    if (!claimed) continue;
    processed += 1;
    await deliverSafely(hook, delivery.event);
  }
  return processed;
}

/**
 * Publishes due scheduled products, pages, and posts and emits the same
 * domain events as a manual publish, so caches and webhooks see the change.
 */
async function processScheduledPublishing(limit: RuntimeValue = 200) {
  const now = new Date();
  const targets: RuntimeValue = [
    [
      Page,
      "content.page.published",
      "page",
      { status: "published" },
      (row: RuntimeValue) => ({ id: row.id, slug: row.slug }),
    ],
    [
      Post,
      "content.post.published",
      "post",
      { status: "published" },
      (row: RuntimeValue) => ({ id: row.id, slug: row.slug }),
    ],
  ];
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    // Products are re-validated and version-bumped before they go live.
    let published = await publishDueProducts(now, limit, transaction);
    for (const [Model, topic, aggregateType, values, payload] of targets) {
      const due: RuntimeValue = await Model.findAll({
        where: { status: "scheduled", publishAt: { [Op.lte]: now } },
        attributes: ["id", "slug"],
        order: [["publishAt", "ASC"]],
        limit,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!due.length) continue;
      await Model.update(values, {
        where: {
          id: { [Op.in]: due.map((row: RuntimeValue) => row.id) },
          status: "scheduled",
        },
        transaction,
      });
      for (const row of due)
        await addDomainEvent({
          topic,
          aggregateType,
          aggregateId: row.id,
          payload: payload(row),
          transaction,
        });
      published += due.length;
    }
    return published;
  });
}

async function expireReservation(
  reservation: RuntimeValue,
  transaction: RuntimeValue,
) {
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
      `Inventory level missing for reservation ${reservation.id}`,
    );
  const nextReserved: RuntimeValue = Math.max(
    0,
    Number(level.reserved) - Number(reservation.quantity),
  );
  await level.update(
    { reserved: nextReserved, version: Number(level.version) + 1 },
    { transaction },
  );
  await reservation.update(
    { status: "expired", releasedAt: new Date() },
    { transaction },
  );
  await InventoryMovement.create(
    {
      id: newId(),
      variantId: reservation.variantId,
      locationId: reservation.locationId,
      orderId: reservation.orderId,
      quantityDelta: 0,
      reservedDelta: -Number(reservation.quantity),
      onHandBefore: Number(level.onHand),
      balanceAfter: Number(level.onHand),
      reservedAfter: nextReserved,
      reason: "reservation_expired",
      correlationId: reservation.id,
    },
    { transaction },
  );
}

/**
 * Expires an unpaid order's stock hold as one unit: every active reservation,
 * the order's own pending payment and attempts, and its reserved coupon usage.
 * The order row is locked first, matching the payment finalizers' lock order.
 */
async function expireOrderHold(orderId: RuntimeValue) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const now = new Date();
    const order: RuntimeValue = await Order.findByPk(orderId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const reservations: RuntimeValue = await InventoryReservation.findAll({
      where: { orderId, status: "active" },
      order: [
        ["variantId", "ASC"],
        ["locationId", "ASC"],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !reservations.some(
        (reservation: RuntimeValue) =>
          new Date(reservation.expiresAt).getTime() <= now.getTime(),
      )
    )
      return 0;
    const pendingPayment = order?.orderStatus === "pending_payment";
    const payments: RuntimeValue = pendingPayment
      ? await Payment.findAll({
          where: { orderId, status: { [Op.in]: ["unpaid", "pending"] } },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : [];
    const paymentIds = payments.map((payment: RuntimeValue) => payment.id);
    const executing: RuntimeValue = paymentIds.length
      ? await PaymentAttempt.count({
          where: { paymentId: { [Op.in]: paymentIds }, status: "executing" },
          transaction,
        })
      : 0;
    if (executing) {
      // bKash may still complete the payment; keep the stock held and let the
      // payment recovery/reconciliation decide before looking again.
      await InventoryReservation.update(
        { expiresAt: new Date(now.getTime() + 10 * 60 * 1000) },
        { where: { orderId, status: "active" }, transaction },
      );
      logger.warn(
        { orderId, job: "reservation.expiry" },
        "Reservation hold extended while a payment is executing",
      );
      return 0;
    }
    for (const reservation of reservations)
      await expireReservation(reservation, transaction);
    if (pendingPayment) {
      if (paymentIds.length) {
        await PaymentAttempt.update(
          { status: "expired" },
          {
            where: {
              paymentId: { [Op.in]: paymentIds },
              status: { [Op.in]: ["created", "redirected"] },
            },
            transaction,
          },
        );
        await Payment.update(
          { status: "failed", failedAt: now },
          { where: { id: { [Op.in]: paymentIds } }, transaction },
        );
      }
      await order.update(
        {
          orderStatus: "failed",
          paymentStatus: "failed",
          version: Number(order.version) + 1,
        },
        { transaction },
      );
      await CouponUsage.update(
        { status: "released" },
        { where: { orderId, status: "reserved" }, transaction },
      );
      await OrderEvent.create(
        {
          id: newId(),
          orderId,
          type: "payment_expired",
          fromStatus: "pending_payment",
          toStatus: "failed",
          message: "The payment window expired.",
          public: true,
        },
        { transaction },
      );
    }
    return reservations.length;
  });
}

async function releaseExpiredReservations(limit: RuntimeValue = 100) {
  const candidates: RuntimeValue = await InventoryReservation.findAll({
    where: { status: "active", expiresAt: { [Op.lte]: new Date() } },
    order: [["expiresAt", "ASC"]],
    limit,
  });
  let released = 0;
  const handledOrders = new Set();
  for (const candidate of candidates) {
    try {
      if (candidate.orderId) {
        if (handledOrders.has(candidate.orderId)) continue;
        handledOrders.add(candidate.orderId);
        released += await expireOrderHold(candidate.orderId);
        continue;
      }
      const didRelease: RuntimeValue = await sequelize.transaction(
        async (transaction: RuntimeValue) => {
          const reservation: RuntimeValue = await InventoryReservation.findOne({
            where: {
              id: candidate.id,
              status: "active",
              expiresAt: { [Op.lte]: new Date() },
            },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!reservation) return false;
          await expireReservation(reservation, transaction);
          return true;
        },
      );
      if (didRelease) released += 1;
    } catch (error: RuntimeValue) {
      logger.error(
        { err: error, jobId: candidate.id, job: "reservation.expiry" },
        "Reservation expiry failed",
      );
    }
  }
  return released;
}

async function processRetentionCleanup() {
  const now = new Date();
  const [quotes, keys, exports]: RuntimeValue = await Promise.all([
    CheckoutQuote.destroy({
      where: {
        expiresAt: { [Op.lt]: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    }),
    IdempotencyRecord.destroy({ where: { expiresAt: { [Op.lt]: now } } }),
    ExportJob.update(
      { status: "expired" },
      { where: { status: "ready", expiresAt: { [Op.lt]: now } } },
    ),
  ]);
  const metaEvents = await purgeMetaCapiEvents(now);
  return { quotes, idempotencyKeys: keys, exports: exports[0], metaEvents };
}

let lastStaleRecovery = 0;
let lastConfirmationSweep = 0;
let lastInboxPurge = 0;

/** Trims the staff inbox at most once an hour. */
async function purgeStaffInbox() {
  if (Date.now() - lastInboxPurge < 60 * 60 * 1000) return 0;
  lastInboxPurge = Date.now();
  return purgeStaffNotifications();
}

/** Auto-cancels unconfirmed COD orders at most once a minute. */
async function sweepUnconfirmedOrders() {
  if (Date.now() - lastConfirmationSweep < 60_000) return 0;
  lastConfirmationSweep = Date.now();
  await expireStaleManualPayments();
  return cancelStaleUnconfirmedOrders();
}

export async function runJobsOnce() {
  if (!sequelize) return;
  // Long-running workers also reclaim rows abandoned by a crashed peer, not
  // only on their own startup.
  if (Date.now() - lastStaleRecovery >= 60_000) {
    lastStaleRecovery = Date.now();
    await recoverStaleJobs().catch((error: RuntimeValue) =>
      logger.error({ err: error, job: "stale.recovery" }, "Job failed"),
    );
  }
  const jobs: [string, () => Promise<unknown>][] = [
    ["notifications", () => processNotifications()],
    ["exports", () => processExports()],
    ["webhooks", () => processWebhooks()],
    ["publishing", () => processScheduledPublishing()],
    ["reservations", () => releaseExpiredReservations()],
    ["cleanup", () => processRetentionCleanup()],
    ["confirmations", () => sweepUnconfirmedOrders()],
    ["inbox", () => purgeStaffInbox()],
    ["meta-capi", () => processMetaCapiQueue()],
  ];
  // One failing job family must not discard the others' results.
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  return Object.fromEntries(
    jobs.map(([name], index) => {
      const result = results[index];
      if (result.status === "fulfilled") return [name, result.value];
      logger.error({ err: result.reason, job: name }, "Job failed");
      return [name, null];
    }),
  );
}
