import { Model } from 'sequelize';
import { DataTypes, initializeModel, optimisticVersion, primaryId } from './shared.js';

/** @type {any} */
export class AuditLog extends Model {}
initializeModel(AuditLog, { id: primaryId(), action: { type: DataTypes.STRING(120), allowNull: false }, resourceType: { type: DataTypes.STRING(100), allowNull: false }, resourceId: DataTypes.CHAR(26), before: DataTypes.JSON, after: DataTypes.JSON, metadata: DataTypes.JSON, requestId: DataTypes.STRING(100), ipAddress: DataTypes.STRING(64), userAgent: DataTypes.STRING(255) }, { modelName: 'AuditLog', tableName: 'audit_logs', updatedAt: false });
/** @type {any} */
export class NotificationTemplate extends Model {}
initializeModel(NotificationTemplate, { id: primaryId(), event: { type: DataTypes.STRING(100), allowNull: false }, channel: { type: DataTypes.ENUM('email', 'sms', 'dashboard'), allowNull: false }, locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, subject: DataTypes.STRING(255), body: { type: DataTypes.TEXT('long'), allowNull: false }, variables: { type: DataTypes.JSON, allowNull: false }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: optimisticVersion() }, { modelName: 'NotificationTemplate', tableName: 'notification_templates' });
/** @type {any} */
export class NotificationOutbox extends Model {}
initializeModel(NotificationOutbox, { id: primaryId(), event: { type: DataTypes.STRING(100), allowNull: false }, channel: { type: DataTypes.ENUM('email', 'sms', 'dashboard'), allowNull: false }, locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, recipient: { type: DataTypes.STRING(255), allowNull: false }, payload: { type: DataTypes.JSON, allowNull: false }, renderedSubject: DataTypes.STRING(255), renderedBody: DataTypes.TEXT('long'), status: { type: DataTypes.ENUM('pending', 'processing', 'sent', 'retry', 'dead'), allowNull: false, defaultValue: 'pending' }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, scheduledAt: { type: DataTypes.DATE, allowNull: false }, sentAt: DataTypes.DATE, providerMessageId: DataTypes.STRING(190), errorCode: DataTypes.STRING(100), lastError: DataTypes.STRING(500) }, { modelName: 'NotificationOutbox', tableName: 'notification_outbox' });
/** @type {any} */
export class OutboxEvent extends Model {}
initializeModel(OutboxEvent, { id: primaryId(), topic: { type: DataTypes.STRING(120), allowNull: false }, aggregateType: { type: DataTypes.STRING(100), allowNull: false }, aggregateId: { type: DataTypes.CHAR(26), allowNull: false }, payload: { type: DataTypes.JSON, allowNull: false }, status: { type: DataTypes.ENUM('pending', 'processing', 'published', 'failed'), allowNull: false, defaultValue: 'pending' }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, availableAt: { type: DataTypes.DATE, allowNull: false }, processedAt: DataTypes.DATE }, { modelName: 'OutboxEvent', tableName: 'outbox_events' });
/** @type {any} */
export class IntegrationCredential extends Model {}
initializeModel(IntegrationCredential, { id: primaryId(), provider: { type: DataTypes.STRING(100), allowNull: false }, environment: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'default' }, encryptedPayload: { type: DataTypes.TEXT('long'), allowNull: false }, maskedLabel: { type: DataTypes.STRING(255), allowNull: false }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, testedAt: DataTypes.DATE, testStatus: DataTypes.STRING(40), version: optimisticVersion() }, { modelName: 'IntegrationCredential', tableName: 'integration_credentials' });
/** @type {any} */
export class Webhook extends Model {}
initializeModel(Webhook, { id: primaryId(), name: { type: DataTypes.STRING(160), allowNull: false }, topics: { type: DataTypes.JSON, allowNull: false }, url: { type: DataTypes.STRING(1000), allowNull: false }, encryptedSecret: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM('active', 'paused', 'disabled'), allowNull: false, defaultValue: 'active' }, failureCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'Webhook', tableName: 'webhooks', paranoid: true });
/** @type {any} */
export class WebhookDelivery extends Model {}
initializeModel(WebhookDelivery, { id: primaryId(), attempt: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, signature: DataTypes.STRING(255), status: { type: DataTypes.ENUM('pending', 'success', 'retry', 'dead'), allowNull: false }, responseCode: DataTypes.INTEGER, durationMs: DataTypes.INTEGER.UNSIGNED, requestBody: DataTypes.JSON, responseExcerpt: DataTypes.STRING(1000), errorCode: DataTypes.STRING(100), nextAttemptAt: DataTypes.DATE }, { modelName: 'WebhookDelivery', tableName: 'webhook_deliveries' });
/** @type {any} */
export class ContactMessage extends Model {}
initializeModel(ContactMessage, { id: primaryId(), name: { type: DataTypes.STRING(120), allowNull: false }, phone: DataTypes.STRING(20), email: DataTypes.STRING(190), subject: { type: DataTypes.STRING(180), allowNull: false }, message: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM('new', 'in_progress', 'resolved', 'spam'), allowNull: false, defaultValue: 'new' }, ipHash: DataTypes.CHAR(64) }, { modelName: 'ContactMessage', tableName: 'contact_messages' });
/** @type {any} */
export class ExportJob extends Model {}
initializeModel(ExportJob, { id: primaryId(), privacyRequestId: { type: DataTypes.CHAR(26), unique: true }, report: { type: DataTypes.STRING(100), allowNull: false }, filters: DataTypes.JSON, status: { type: DataTypes.ENUM('queued', 'processing', 'ready', 'failed', 'expired'), allowNull: false }, expiresAt: DataTypes.DATE, errorCode: DataTypes.STRING(100) }, { modelName: 'ExportJob', tableName: 'export_jobs' });
