import { NotificationOutbox, OutboxEvent } from "../../db/models.js";
import { newId } from "../../lib/ids.js";
import type { Transaction } from "sequelize";

export function addDomainEvent({
  topic,
  aggregateType,
  aggregateId,
  payload,
  transaction,
  availableAt = new Date(),
}: {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  transaction?: Transaction | null;
  availableAt?: Date;
}) {
  return OutboxEvent.create(
    {
      id: newId(),
      topic,
      aggregateType,
      aggregateId,
      payload,
      status: "pending",
      attempts: 0,
      availableAt,
    },
    { transaction },
  );
}

export function queueNotification({
  event,
  channel,
  locale = "en",
  recipient,
  payload,
  templateId = null,
  transaction,
  scheduledAt = new Date(),
}: {
  event: string;
  channel: string;
  locale?: string;
  recipient: string;
  payload: unknown;
  templateId?: string | null;
  transaction?: Transaction | null;
  scheduledAt?: Date;
}) {
  return NotificationOutbox.create(
    {
      id: newId(),
      event,
      channel,
      locale,
      recipient,
      payload,
      templateId,
      status: "pending",
      attempts: 0,
      scheduledAt,
    },
    { transaction },
  );
}
