import { AuditLog } from "../../db/models.js";
import { newId } from "../../lib/ids.js";
import type { Request } from "express";
import type { Transaction } from "sequelize";

const sensitiveKey =
  /password|secret|token|authorization|cookie|otp|credential|privateKey/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]: RuntimeValue) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redact(item),
    ]),
  );
}

export async function recordAudit({
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  before = null,
  after = null,
  metadata = null,
  request = null,
  transaction,
}: {
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  request?: Request | null;
  transaction?: Transaction | null;
}) {
  return AuditLog.create(
    {
      id: newId(),
      actorId,
      action,
      resourceType,
      resourceId,
      before: before ? redact(before) : null,
      after: after ? redact(after) : null,
      metadata: metadata ? redact(metadata) : null,
      requestId: request?.id || null,
      ipAddress: request?.ip?.slice(0, 64) || null,
      userAgent: request?.get?.("user-agent")?.slice(0, 255) || null,
    },
    { transaction },
  );
}
