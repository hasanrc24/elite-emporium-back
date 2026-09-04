import { NotificationOutbox, OutboxEvent } from '../../db/models.js';
import { newId } from '../../lib/ids.js';

export function addDomainEvent({ topic, aggregateType, aggregateId, payload, transaction, availableAt = new Date() }) {
  return OutboxEvent.create({ id: newId(), topic, aggregateType, aggregateId, payload, status: 'pending', attempts: 0, availableAt }, { transaction });
}

export function queueNotification({ event, channel, locale = 'en', recipient, payload, templateId = null, transaction, scheduledAt = new Date() }) {
  return NotificationOutbox.create({ id: newId(), event, channel, locale, recipient, payload, templateId, status: 'pending', attempts: 0, scheduledAt }, { transaction });
}
