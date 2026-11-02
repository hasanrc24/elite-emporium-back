import { env } from "../../config/env.js";
import nodemailer from "nodemailer";
import { FeatureFlag, IntegrationCredential } from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audits/audit.service.js";
import { assertPublicHostname, postToPublicUrl } from "./outbound.js";
import {
  BkashProviderError,
  testBkashConnection,
} from "../payments/bkash.adapter.js";

function integrationDto(row: RuntimeValue) {
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

export async function listIntegrations() {
  const rows: RuntimeValue = await IntegrationCredential.findAll({
    order: [
      ["provider", "ASC"],
      ["environment", "ASC"],
    ],
  });
  return rows.map(integrationDto);
}

const supportedMessagingProviders = new Set(["smtp", "sms"]);
function assertMessagingProvider(provider: RuntimeValue) {
  if (!supportedMessagingProviders.has(provider))
    throw AppError.notFound("Integration provider not found.");
}

function messagingLabel(provider: RuntimeValue, values: RuntimeValue) {
  return provider === "smtp"
    ? `${values.host}:${values.port} · ${values.from}`
    : `${new URL(values.url).hostname} · ${values.recipientField || "to"}`;
}

export async function configureMessaging(
  provider: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  assertMessagingProvider(provider);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const environment = payload.environment || "default";
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
    const before: RuntimeValue = row ? integrationDto(row) : null;
    const values =
      provider === "smtp"
        ? {
            host: payload.host,
            port: payload.port,
            secure: payload.secure,
            username: payload.username || "",
            password: payload.password || "",
            from: payload.from,
          }
        : {
            url: payload.url,
            token: payload.token || "",
            tokenHeader: payload.tokenHeader || "authorization",
            tokenScheme: payload.tokenScheme || "Bearer",
            recipientField: payload.recipientField || "to",
            messageField: payload.messageField || "message",
          };
    const record: RuntimeValue = {
      provider,
      environment,
      encryptedPayload: encryptSecret(values),
      maskedLabel: messagingLabel(provider, values),
      active: false,
      testedAt: null,
      testStatus: "untested",
      updatedBy: actorId,
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
      action: `integration.${provider}_configure`,
      resourceType: "integration",
      resourceId: row.id,
      before,
      after: integrationDto(row),
      request,
      transaction,
    });
    return integrationDto(row);
  });
}

export async function testMessaging(
  provider: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  assertMessagingProvider(provider);
  const row: RuntimeValue = await IntegrationCredential.findOne({
    where: { provider, environment: payload.environment || "default" },
  });
  if (!row)
    throw AppError.notFound(
      `${provider.toUpperCase()} credentials are not configured.`,
    );
  const config: RuntimeValue = decryptSecret(row.encryptedPayload);
  try {
    if (provider === "smtp") {
      // Resolve the host: names such as "mysql" or "redis" are internal
      // services even though they do not look like private addresses.
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
      await transport.verify();
    } else {
      // Pins the connection to the validated address (no DNS rebinding) and
      // never follows redirects.
      const response: RuntimeValue = await postToPublicUrl(
        config.url,
        {
          "content-type": "application/json",
          ...(config.token
            ? {
                [config.tokenHeader]: config.tokenScheme
                  ? `${config.tokenScheme} ${config.token}`
                  : config.token,
              }
            : {}),
        },
        JSON.stringify({
          [config.recipientField]: payload.testRecipient,
          [config.messageField]: "Elite Emporium integration test",
        }),
      );
      if (!response.ok)
        throw new AppError(
          422,
          "SMS_PROVIDER_TEST_FAILED",
          `SMS provider returned ${response.status}.`,
        );
    }
    await row.update({
      testedAt: new Date(),
      testStatus: "success",
      version: row.version + 1,
      updatedBy: actorId,
    });
    await recordAudit({
      actorId,
      action: `integration.${provider}_test_success`,
      resourceType: "integration",
      resourceId: row.id,
      request,
      transaction: null,
    });
    return integrationDto(row);
  } catch (error: RuntimeValue) {
    await row.update({
      testedAt: new Date(),
      testStatus: "failed",
      version: row.version + 1,
      updatedBy: actorId,
    });
    await recordAudit({
      actorId,
      action: `integration.${provider}_test_failed`,
      resourceType: "integration",
      resourceId: row.id,
      metadata: { code: error.code || "INTEGRATION_TEST_FAILED" },
      request,
      transaction: null,
    });
    if (error instanceof AppError) throw error;
    if (
      error.code === "UNSAFE_INTEGRATION_HOST" ||
      error.code === "UNSAFE_INTEGRATION_URL"
    )
      throw AppError.unprocessable(
        error.code,
        "The integration host must be a public HTTPS endpoint.",
      );
    throw new AppError(
      422,
      "INTEGRATION_TEST_FAILED",
      `The ${provider.toUpperCase()} connection test failed.`,
    );
  }
}

export async function setMessagingEnabled(
  provider: RuntimeValue,
  enabled: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  assertMessagingProvider(provider);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await IntegrationCredential.findOne({
      where: { provider, environment: "default" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row)
      throw AppError.notFound(
        `${provider.toUpperCase()} credentials are not configured.`,
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
      action: `integration.${provider}_${enabled ? "enable" : "disable"}`,
      resourceType: "integration",
      resourceId: row.id,
      after: integrationDto(row),
      request,
      transaction,
    });
    return integrationDto(row);
  });
}

export async function configureBkash(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const environment = payload.environment || env.BKASH_MODE;
    let row: RuntimeValue = await IntegrationCredential.findOne({
      where: { provider: "bkash", environment },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This integration changed. Refresh and review the latest version.",
      );
    const before: RuntimeValue = row ? integrationDto(row) : null;
    const values: RuntimeValue = {
      username: payload.username,
      password: payload.password,
      appKey: payload.appKey,
      appSecret: payload.appSecret,
    };
    if (!row)
      row = await IntegrationCredential.create(
        {
          id: newId(),
          provider: "bkash",
          environment,
          encryptedPayload: encryptSecret(values),
          maskedLabel: `App key ${maskSecret(payload.appKey)}`,
          active: false,
          testedAt: null,
          testStatus: "untested",
          version: 1,
          updatedBy: actorId,
        },
        { transaction },
      );
    else
      await row.update(
        {
          encryptedPayload: encryptSecret(values),
          maskedLabel: `App key ${maskSecret(payload.appKey)}`,
          active: false,
          testedAt: null,
          testStatus: "untested",
          version: row.version + 1,
          updatedBy: actorId,
        },
        { transaction },
      );
    const [flag]: RuntimeValue = await FeatureFlag.findOrCreate({
      where: { key: "bkash" },
      defaults: {
        id: newId(),
        key: "bkash",
        enabled: false,
        config: { tested: false },
        version: 1,
        updatedBy: actorId,
      },
      transaction,
    });
    await flag.update(
      {
        enabled: false,
        config: { tested: false },
        version: flag.version + 1,
        updatedBy: actorId,
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "integration.bkash_configure",
      resourceType: "integration",
      resourceId: row.id,
      before,
      after: integrationDto(row),
      request,
      transaction,
    });
    return integrationDto(row);
  });
}

export async function testBkash(actorId: RuntimeValue, request: RuntimeValue) {
  const row: RuntimeValue = await IntegrationCredential.findOne({
    where: { provider: "bkash", environment: env.BKASH_MODE },
  });
  if (!row) throw AppError.notFound("bKash credentials are not configured.");
  try {
    const result: RuntimeValue = await testBkashConnection(
      decryptSecret(row.encryptedPayload),
    );
    await sequelize.transaction(async (transaction: RuntimeValue) => {
      const locked: RuntimeValue = await IntegrationCredential.findByPk(
        row.id,
        {
          transaction,
          lock: transaction.LOCK.UPDATE,
        },
      );
      locked.testedAt = new Date();
      locked.testStatus = "success";
      locked.version += 1;
      locked.updatedBy = actorId;
      await locked.save({ transaction });
      await recordAudit({
        actorId,
        action: "integration.bkash_test_success",
        resourceType: "integration",
        resourceId: row.id,
        request,
        transaction,
      });
    });
    return { ...result, testedAt: new Date().toISOString() };
  } catch (error: RuntimeValue) {
    await row.update({
      testedAt: new Date(),
      testStatus: "failed",
      version: row.version + 1,
      updatedBy: actorId,
    });
    await recordAudit({
      actorId,
      action: "integration.bkash_test_failed",
      resourceType: "integration",
      resourceId: row.id,
      metadata: { code: error.code || "BKASH_TEST_FAILED" },
      request,
      transaction: null,
    });
    if (error instanceof BkashProviderError)
      throw new AppError(
        error.retryable ? 503 : 422,
        error.code,
        error.message,
      );
    throw error;
  }
}

export async function setBkashEnabled(
  enabled: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  if (enabled && !env.BKASH_ENABLED)
    throw AppError.conflict(
      "BKASH_ENV_DISABLED",
      "Set BKASH_ENABLED=true on the server before enabling bKash.",
    );
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await IntegrationCredential.findOne({
      where: { provider: "bkash", environment: env.BKASH_MODE },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("bKash credentials are not configured.");
    if (enabled && (row.testStatus !== "success" || !row.testedAt))
      throw AppError.conflict(
        "BKASH_TEST_REQUIRED",
        "A successful bKash connection test is required before enabling it.",
      );
    row.active = enabled;
    row.version += 1;
    row.updatedBy = actorId;
    await row.save({ transaction });
    const [flag]: RuntimeValue = await FeatureFlag.findOrCreate({
      where: { key: "bkash" },
      defaults: {
        id: newId(),
        key: "bkash",
        enabled,
        config: { tested: row.testStatus === "success" },
        version: 1,
        updatedBy: actorId,
      },
      transaction,
    });
    if (!flag.isNewRecord)
      await flag.update(
        {
          enabled,
          config: {
            tested: row.testStatus === "success",
            testedAt: row.testedAt,
          },
          version: flag.version + 1,
          updatedBy: actorId,
        },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: enabled
        ? "integration.bkash_enable"
        : "integration.bkash_disable",
      resourceType: "integration",
      resourceId: row.id,
      after: integrationDto(row),
      request,
      transaction,
    });
    return integrationDto(row);
  });
}
