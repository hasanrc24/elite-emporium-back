import { Op } from "sequelize";
import { env } from "../../config/env.js";
import { IntegrationCredential, MetaCapiEvent } from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import { moneyString } from "../../lib/money.js";
import { recordAudit } from "../audits/audit.service.js";
import { postToPublicUrl } from "../integrations/outbound.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { settingValue } from "../settings/settings.service.js";
import {
  buildCustomData,
  buildEvent,
  buildUserData,
  classifyResponse,
  graphApiVersion,
  isPixelId,
  isTokenError,
  maxAttempts,
  maxEventAgeMs,
  relayedEventNames,
  retryDelaySeconds,
  safeSourceUrl,
  type ContentLine,
  type MetaEvent,
} from "./meta-capi.js";

const provider = "meta_capi";
const environment = "default";

type Runtime = {
  pixelId: string;
  accessToken: string;
  consentRequired: boolean;
};

function credentialDto(row: RuntimeValue) {
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    maskedLabel: row.maskedLabel,
    active: row.active,
    testedAt: row.testedAt,
    testStatus: row.testStatus,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/**
 * Everything needed to send, or null when server-side tracking is off. Both
 * the integration (token, enabled and tested) and the analytics settings
 * (Meta provider, pixel ID, server-side switch) must agree.
 */
async function loadRuntime(transaction: RuntimeValue = null) {
  const [analytics, credential]: RuntimeValue = await Promise.all([
    settingValue("analytics", transaction),
    IntegrationCredential.findOne({
      where: { provider, environment, active: true },
      transaction,
    }),
  ]);
  if (
    !credential ||
    analytics.provider !== "meta" ||
    !analytics.serverSide ||
    !isPixelId(analytics.publicMeasurementId)
  )
    return null;
  const secret: RuntimeValue = decryptSecret(credential.encryptedPayload);
  if (!secret?.accessToken) return null;
  return {
    pixelId: String(analytics.publicMeasurementId),
    accessToken: String(secret.accessToken),
    consentRequired: analytics.consentRequired !== false,
  } satisfies Runtime;
}

async function enqueue(
  events: { event: MetaEvent; held?: boolean }[],
  transaction: RuntimeValue = null,
) {
  if (!events.length) return;
  const now = new Date();
  await MetaCapiEvent.bulkCreate(
    events.map(({ event, held }) => ({
      id: newId(),
      eventId: event.event_id,
      eventName: event.event_name,
      eventTime: new Date(event.event_time * 1000),
      payload: event,
      status: held ? "held" : "pending",
      attempts: 0,
      nextAttemptAt: now,
    })),
    // A repeated event ID (browser retry, replayed request) is dropped.
    { ignoreDuplicates: true, transaction },
  );
}

export type TrackingContext = {
  consent?: boolean;
  fbp?: string | null;
  fbc?: string | null;
  sourceUrl?: string | null;
};

const requestIp = (request: RuntimeValue) =>
  request?.ip ? String(request.ip).replace(/^::ffff:/, "") : null;
const requestAgent = (request: RuntimeValue) =>
  request?.get?.("user-agent") || null;

const purchaseEventId = (reference: string) => `purchase_${reference}`;

/**
 * Queues the Purchase conversion for a storefront order. Cash on delivery
 * orders are sent right away; prepaid orders are `held` until payment
 * succeeds (releasePurchaseEvent). The browser pixel uses the same event ID,
 * so Meta counts it once.
 */
export async function queuePurchaseEvent({
  order,
  lines,
  tracking,
  address,
  userId,
  request,
  held,
  transaction,
}: {
  order: RuntimeValue;
  lines: { productId: string; quantity: number; unitPrice: string }[];
  tracking: TrackingContext | null | undefined;
  address: RuntimeValue;
  userId: string | null | undefined;
  request: RuntimeValue;
  held: boolean;
  transaction: RuntimeValue;
}) {
  try {
    const runtime = await loadRuntime(transaction);
    if (!runtime) return;
    if (runtime.consentRequired && tracking?.consent !== true) return;
    const event = buildEvent({
      name: "Purchase",
      eventId: purchaseEventId(order.reference),
      eventTime: new Date(),
      sourceUrl: safeSourceUrl(tracking?.sourceUrl, env.PUBLIC_ORIGIN),
      userData: buildUserData({
        email: order.customerEmail,
        phone: order.customerPhone,
        name: order.customerName,
        city: address?.district || address?.area,
        postcode: address?.postcode,
        externalId: userId,
        ip: requestIp(request),
        userAgent: requestAgent(request),
        fbp: tracking?.fbp,
        fbc: tracking?.fbc,
      }),
      customData: buildCustomData({
        value: moneyString(order.grandTotal),
        currency: "BDT",
        contents: lines.map((line): ContentLine => ({
          id: line.productId,
          quantity: line.quantity,
          price: line.unitPrice,
        })),
      }),
    });
    await enqueue([{ event, held }], transaction);
  } catch (error) {
    // Tracking must never block or roll back a checkout.
    logger.error({ err: error, job: "meta-capi.queue" }, "Purchase not queued");
  }
}

/** Releases a prepaid order's held Purchase once its payment is confirmed. */
export async function releasePurchaseEvent(
  reference: string,
  transaction: RuntimeValue,
) {
  try {
    const row: RuntimeValue = await MetaCapiEvent.findOne({
      where: { eventId: purchaseEventId(reference), status: "held" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) return;
    const now = new Date();
    row.payload = {
      ...row.payload,
      event_time: Math.floor(now.getTime() / 1000),
    };
    row.eventTime = now;
    row.status = "pending";
    row.nextAttemptAt = now;
    await row.save({ transaction });
  } catch (error) {
    logger.error(
      { err: error, job: "meta-capi.release" },
      "Purchase not released",
    );
  }
}

const eventIdPattern = /^[A-Za-z0-9_.:-]{8,100}$/;

/** Browser-relayed events (ViewContent, AddToCart, …) with the shared event ID. */
export async function recordClientEvents(
  body: RuntimeValue,
  request: RuntimeValue,
) {
  const runtime = await loadRuntime();
  if (!runtime || (runtime.consentRequired && body.consent !== true))
    return { accepted: 0 };
  const user: RuntimeValue = request.auth?.user;
  const events: { event: MetaEvent }[] = [];
  for (const item of body.events as RuntimeValue[]) {
    if (!(relayedEventNames as readonly string[]).includes(item.name)) continue;
    if (!eventIdPattern.test(String(item.eventId))) continue;
    events.push({
      event: buildEvent({
        name: item.name,
        eventId: String(item.eventId),
        eventTime: new Date(),
        sourceUrl: safeSourceUrl(item.sourceUrl, env.PUBLIC_ORIGIN),
        userData: buildUserData({
          email: user?.email,
          phone: user?.phone,
          name: user?.name,
          externalId: user?.id,
          ip: requestIp(request),
          userAgent: requestAgent(request),
          fbp: body.fbp,
          fbc: body.fbc,
        }),
        customData: buildCustomData({
          value: item.value,
          currency: "BDT",
          contents: item.contents,
          searchString: item.searchString,
          contentName: item.contentName,
        }),
      }),
    });
  }
  await enqueue(events);
  return { accepted: events.length };
}

async function sendToMeta(
  runtime: Runtime,
  events: MetaEvent[],
  options: { testEventCode?: string | null } = {},
) {
  // Only the connection test is marked as a test; real events never are.
  const testCode = options.testEventCode;
  try {
    const response = await postToPublicUrl(
      `https://graph.facebook.com/${graphApiVersion}/${runtime.pixelId}/events`,
      { "content-type": "application/json" },
      // The token travels in the body, never in the URL that could be logged.
      JSON.stringify({
        data: events,
        access_token: runtime.accessToken,
        ...(testCode ? { test_event_code: testCode } : {}),
      }),
      15_000,
    );
    let parsed: RuntimeValue = null;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      /* non-JSON error page */
    }
    return {
      outcome: classifyResponse(response.status, parsed),
      status: response.status,
      body: parsed,
    };
  } catch {
    // Network failure, timeout or an unsafe host: retry later.
    return { outcome: "retry" as const, status: 0, body: null };
  }
}

function errorText(result: { status: number; body: RuntimeValue }) {
  const error = result.body?.error;
  const message = error?.message
    ? `${error.message}${error.code ? ` (code ${error.code})` : ""}`
    : `HTTP ${result.status}`;
  return `${message}${result.body?.fbtrace_id ? ` · ${result.body.fbtrace_id}` : ""}`.slice(
    0,
    500,
  );
}

async function settle(
  row: RuntimeValue,
  result: { outcome: string; status: number; body: RuntimeValue },
) {
  const attempts = Number(row.attempts) + 1;
  if (result.outcome === "sent") {
    await row.update({
      status: "sent",
      attempts,
      sentAt: new Date(),
      leaseUntil: null,
      lastError: null,
    });
    return "sent";
  }
  // A rejected token is a setup problem, not a bad event: keep the event and
  // try again later (it still ages out after 6 days) instead of losing it.
  if (isTokenError(result.body)) {
    await row.update({
      status: "pending",
      leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + 30 * 60_000),
      lastError: errorText(result),
    });
    return "retry";
  }
  const exhausted = attempts >= maxAttempts;
  if (result.outcome === "retry" && !exhausted) {
    await row.update({
      status: "pending",
      attempts,
      leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + retryDelaySeconds(attempts) * 1000),
      lastError: errorText(result),
    });
    return "retry";
  }
  await row.update({
    status: "failed",
    attempts,
    leaseUntil: null,
    lastError: errorText(result),
  });
  return "failed";
}

/** Delivers due events in small batches. Safe to run from several workers. */
export async function processMetaCapiQueue(limit = 50) {
  const now = new Date();
  const due: RuntimeValue[] = await MetaCapiEvent.findAll({
    where: {
      [Op.or]: [
        { status: "pending", nextAttemptAt: { [Op.lte]: now } },
        { status: "processing", leaseUntil: { [Op.lt]: now } },
      ],
    },
    order: [["createdAt", "ASC"]],
    limit,
  });
  if (!due.length) return 0;
  const runtime = await loadRuntime();
  // Tracking switched off: leave the rows; they age out if it stays off.
  if (!runtime) return 0;
  const claimed: RuntimeValue[] = [];
  const lease = new Date(Date.now() + 2 * 60_000);
  for (const row of due) {
    if (now.getTime() - new Date(row.eventTime).getTime() > maxEventAgeMs) {
      await row.update({
        status: "failed",
        lastError: "Too old for Meta to accept (over 6 days).",
        leaseUntil: null,
      });
      continue;
    }
    const [count] = await MetaCapiEvent.update(
      { status: "processing", leaseUntil: lease },
      { where: { id: row.id, status: row.status, attempts: row.attempts } },
    );
    if (count) {
      row.status = "processing";
      claimed.push(row);
    }
  }
  if (!claimed.length) return 0;
  let sent = 0;
  const result = await sendToMeta(
    runtime,
    claimed.map((row) => row.payload),
  );
  if (
    result.outcome === "failed" &&
    claimed.length > 1 &&
    !isTokenError(result.body)
  ) {
    // One bad event rejects the whole batch: resend one by one to isolate it.
    for (const row of claimed) {
      const single = await sendToMeta(runtime, [row.payload]);
      if ((await settle(row, single)) === "sent") sent += 1;
      if (isTokenError(single.body)) await alertTokenProblem();
    }
    return sent;
  }
  for (const row of claimed)
    if ((await settle(row, result)) === "sent") sent += 1;
  if (isTokenError(result.body)) await alertTokenProblem();
  return sent;
}

async function alertTokenProblem() {
  await notifyStaff("platform", {
    event: "tracking.meta_token_rejected",
    title: "Meta rejected the Conversions API access token",
    message:
      "Server-side events are failing. Create a new access token in Meta Events Manager and save it under Settings → SEO and analytics.",
    link: "/admin/settings/seo",
    severity: "critical",
    dedupeKey: "tracking.meta_token_rejected",
  }).catch(() => undefined);
}

/** Housekeeping: sent rows after 14 days, stale failed/held rows after 30. */
export async function purgeMetaCapiEvents(now = new Date()) {
  const day = 24 * 3600 * 1000;
  const sent = await MetaCapiEvent.destroy({
    where: {
      status: "sent",
      createdAt: { [Op.lt]: new Date(now.getTime() - 14 * day) },
    },
  });
  const stale = await MetaCapiEvent.destroy({
    where: {
      status: { [Op.in]: ["failed", "held"] },
      createdAt: { [Op.lt]: new Date(now.getTime() - 30 * day) },
    },
  });
  return sent + stale;
}

// ---- Admin: credential, test, enable, status ----

async function configureMetaCapi(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = await IntegrationCredential.findOne({
      where: { provider, environment },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This integration changed. Refresh and review the latest version.",
      );
    const existing: RuntimeValue = row
      ? decryptSecret(row.encryptedPayload)
      : null;
    const accessToken = payload.accessToken || existing?.accessToken;
    if (!accessToken)
      throw AppError.unprocessable(
        "ACCESS_TOKEN_REQUIRED",
        "Enter the Conversions API access token.",
        { accessToken: ["Enter the access token."] },
      );
    const tokenChanged = !existing || accessToken !== existing.accessToken;
    const before: RuntimeValue = row ? credentialDto(row) : null;
    const record: RuntimeValue = {
      provider,
      environment,
      encryptedPayload: encryptSecret({ accessToken }),
      maskedLabel: `Token ${maskSecret(accessToken)}`,
      updatedBy: actorId,
      // A new token must pass a test again before events are sent with it.
      ...(tokenChanged
        ? { active: false, testedAt: null, testStatus: "untested" }
        : {}),
    };
    if (!row)
      row = await IntegrationCredential.create(
        { id: newId(), ...record, version: 1 },
        { transaction },
      );
    else
      await row.update(
        { ...record, version: row.version + 1 },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: "integration.meta_capi_configure",
      resourceType: "integration",
      resourceId: row.id,
      before,
      after: credentialDto(row),
      request,
      transaction,
    });
    return credentialDto(row);
  });
}

async function testMetaCapi(
  testEventCode: string,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const [row, analytics]: RuntimeValue = await Promise.all([
    IntegrationCredential.findOne({ where: { provider, environment } }),
    settingValue("analytics"),
  ]);
  if (!row)
    throw AppError.notFound("Conversions API credentials are not configured.");
  const secret: RuntimeValue = decryptSecret(row.encryptedPayload);
  if (!isPixelId(analytics.publicMeasurementId))
    throw AppError.unprocessable(
      "PIXEL_ID_REQUIRED",
      "Set the Meta Pixel ID under Settings → SEO and analytics first.",
    );
  if (!testEventCode)
    throw AppError.unprocessable(
      "TEST_EVENT_CODE_REQUIRED",
      "Enter the test event code from Events Manager → Test events. The test sends one test event that never counts as a real conversion.",
    );
  const runtime: Runtime = {
    pixelId: String(analytics.publicMeasurementId),
    accessToken: String(secret.accessToken),
    consentRequired: true,
  };
  const result = await sendToMeta(
    runtime,
    [
      buildEvent({
        name: "PageView",
        eventId: `test_${newId()}`,
        eventTime: new Date(),
        sourceUrl: env.PUBLIC_ORIGIN,
        userData: buildUserData({
          email: "connection-test@example.com",
          userAgent: "EliteEmporium-ConnectionTest",
          ip: "203.0.113.1",
        }),
        customData: {},
      }),
    ],
    { testEventCode },
  );
  const ok = result.outcome === "sent";
  await row.update({
    testedAt: new Date(),
    testStatus: ok ? "success" : "failed",
    version: row.version + 1,
    updatedBy: actorId,
  });
  await recordAudit({
    actorId,
    action: `integration.meta_capi_test_${ok ? "success" : "failed"}`,
    resourceType: "integration",
    resourceId: row.id,
    request,
    transaction: null,
  });
  if (!ok)
    throw AppError.unprocessable(
      isTokenError(result.body)
        ? "META_TOKEN_REJECTED"
        : "INTEGRATION_TEST_FAILED",
      isTokenError(result.body)
        ? "Meta rejected the access token. Create a new one in Events Manager."
        : `Meta did not accept the test event: ${errorText(result)}`,
    );
  return credentialDto(row);
}

async function setMetaCapiEnabled(
  enabled: boolean,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await IntegrationCredential.findOne({
      where: { provider, environment },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row)
      throw AppError.notFound(
        "Conversions API credentials are not configured.",
      );
    if (enabled && row.testStatus !== "success")
      throw AppError.conflict(
        "INTEGRATION_TEST_REQUIRED",
        "A successful connection test is required before enabling this integration.",
      );
    await row.update(
      { active: enabled, version: row.version + 1, updatedBy: actorId },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: `integration.meta_capi_${enabled ? "enable" : "disable"}`,
      resourceType: "integration",
      resourceId: row.id,
      after: credentialDto(row),
      request,
      transaction,
    });
    return credentialDto(row);
  });
}

export async function getMetaCapiStatus() {
  const [row, analytics]: RuntimeValue = await Promise.all([
    IntegrationCredential.findOne({ where: { provider, environment } }),
    settingValue("analytics"),
  ]);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [
    pending,
    held,
    sent24h,
    failed24h,
    lastFailure,
    lastSent,
  ]: RuntimeValue = await Promise.all([
    MetaCapiEvent.count({
      where: { status: { [Op.in]: ["pending", "processing"] } },
    }),
    MetaCapiEvent.count({ where: { status: "held" } }),
    MetaCapiEvent.count({
      where: { status: "sent", sentAt: { [Op.gte]: since } },
    }),
    MetaCapiEvent.count({
      where: { status: "failed", updatedAt: { [Op.gte]: since } },
    }),
    MetaCapiEvent.findOne({
      where: { status: "failed" },
      order: [["updatedAt", "DESC"]],
      attributes: ["lastError", "updatedAt"],
    }),
    MetaCapiEvent.findOne({
      where: { status: "sent" },
      order: [["sentAt", "DESC"]],
      attributes: ["sentAt"],
    }),
  ]);
  const providerIsMeta = analytics.provider === "meta";
  const pixelOk = isPixelId(analytics.publicMeasurementId);
  return {
    credential: row ? credentialDto(row) : null,
    pixelId: pixelOk ? String(analytics.publicMeasurementId) : null,
    providerIsMeta,
    serverSide: Boolean(analytics.serverSide),
    ready: Boolean(
      row?.active && providerIsMeta && analytics.serverSide && pixelOk,
    ),
    queue: { pending, held, sent24h, failed24h },
    lastError: lastFailure?.lastError || null,
    lastSentAt: lastSent?.sentAt || null,
  };
}

/**
 * One step for the admin: save the token (when given), prove it with a test
 * event, then switch the integration on. The test code is used only for the
 * test and is never stored, so real events are never marked as tests.
 */
export async function connectMetaCapi(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  await configureMetaCapi(payload, actorId, request);
  await testMetaCapi(payload.testEventCode, actorId, request);
  return setMetaCapiEnabled(true, actorId, request);
}
