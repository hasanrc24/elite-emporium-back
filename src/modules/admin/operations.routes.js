import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as operations from './operations.service.js';

export const adminOperationsRouter = Router();
adminOperationsRouter.use(authenticate);

adminOperationsRouter.get('/audits', requirePermission('audits.view'), async (req, res) => { const result = await operations.listAudits(req.query); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.get('/reports/summary', requirePermission('reports.view'), async (req, res) => res.json({ data: await operations.reportSummary(req.query), meta: null, requestId: req.id }));
adminOperationsRouter.get('/reports/:report', requirePermission('reports.view'), async (req, res) => res.json({ data: await operations.reportData(req.params.report, req.query), meta: null, requestId: req.id }));
adminOperationsRouter.get('/exports', requirePermission('reports.view'), async (req, res) => { const result = await operations.listExports(req.query, req.auth.user.id); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.post('/exports', requirePermission('reports.export'), validate(z.object({ report: z.enum(['orders', 'sales', 'products', 'inventory', 'customers', 'coupons', 'payments', 'returns', 'profit', 'audits']), filters: z.record(z.string(), z.unknown()).optional() })), async (req, res) => res.status(202).json({ data: await operations.createExport(req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.get('/exports/:id', requirePermission('reports.view'), async (req, res) => res.json({ data: await operations.getExport(req.params.id), meta: null, requestId: req.id }));
adminOperationsRouter.post('/exports/:id/cancel', requirePermission('reports.export'), async (req, res) => res.json({ data: await operations.cancelExport(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));

adminOperationsRouter.get('/notifications/templates', requirePermission('notifications.manage'), async (req, res) => { const result = await operations.listNotificationTemplates(req.query); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.get('/notifications/templates/:id', requirePermission('notifications.manage'), async (req, res) => res.json({ data: await operations.getNotificationTemplate(req.params.id), meta: null, requestId: req.id }));
adminOperationsRouter.patch('/notifications/templates/:id', requirePermission('notifications.manage'), validate(z.object({ subject: z.string().trim().max(255).nullable().optional(), body: z.string().trim().min(1).max(20000), active: z.boolean(), version: z.number().int().positive() })), async (req, res) => res.json({ data: await operations.updateNotificationTemplate(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.post('/notifications/templates/:id/preview', requirePermission('notifications.manage'), validate(z.object({ variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })), async (req, res) => res.json({ data: await operations.previewNotificationTemplate(req.params.id, req.body.variables), meta: null, requestId: req.id }));
adminOperationsRouter.post('/notifications/templates/:id/test', requirePermission('notifications.manage'), validate(z.object({ recipient: z.string().trim().min(3).max(255), variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })), async (req, res) => res.status(202).json({ data: await operations.testNotificationTemplate(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.get('/notifications/outbox', requirePermission('notifications.manage'), async (req, res) => { const result = await operations.listNotificationOutbox(req.query); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.get('/notifications/outbox/:id', requirePermission('notifications.manage'), async (req, res) => res.json({ data: await operations.getNotificationDelivery(req.params.id), meta: null, requestId: req.id }));
adminOperationsRouter.post('/notifications/outbox/:id/retry', requirePermission('notifications.manage'), async (req, res) => res.json({ data: await operations.retryNotification(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));

const webhookSchema = z.object({ name: z.string().trim().min(2).max(160), topics: z.array(z.string().trim().min(2).max(120)).min(1).max(50), url: z.string().url().max(1000), secret: z.string().min(24).max(500).optional(), status: z.enum(['active', 'paused', 'disabled']).default('active'), version: z.number().int().positive().optional() });
adminOperationsRouter.get('/webhooks', requirePermission('webhooks.manage'), async (req, res) => res.json({ data: await operations.listWebhooks(req.query), meta: null, requestId: req.id }));
adminOperationsRouter.post('/webhooks', requirePermission('webhooks.manage'), validate(webhookSchema), async (req, res) => res.status(201).json({ data: await operations.saveWebhook(null, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.patch('/webhooks/:id', requirePermission('webhooks.manage'), validate(webhookSchema.extend({ version: z.number().int().positive() })), async (req, res) => res.json({ data: await operations.saveWebhook(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.get('/webhooks/:id/deliveries', requirePermission('webhooks.manage'), async (req, res) => { const result = await operations.listWebhookDeliveries(req.params.id, req.query); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.post('/webhooks/:id/test', requirePermission('webhooks.manage'), async (req, res) => res.json({ data: await operations.testWebhook(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.post('/webhooks/:id/rotate-secret', requirePermission('webhooks.manage'), validate(z.object({ secret: z.string().min(24).max(500), version: z.number().int().positive() })), async (req, res) => res.json({ data: await operations.rotateWebhookSecret(req.params.id, req.body.secret, req.body.version, req.auth.user.id, req), meta: null, requestId: req.id }));
adminOperationsRouter.delete('/webhooks/:id', requirePermission('webhooks.manage'), async (req, res) => { await operations.archiveWebhook(req.params.id, req.auth.user.id, req); res.status(204).end(); });
adminOperationsRouter.post('/webhook-deliveries/:id/retry', requirePermission('webhooks.manage'), async (req, res) => res.json({ data: await operations.retryWebhookDelivery(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));

adminOperationsRouter.get('/contact-messages', requirePermission('customers.view'), async (req, res) => { const result = await operations.listContactMessages(req.query); res.json({ ...result, requestId: req.id }); });
adminOperationsRouter.patch('/contact-messages/:id', requirePermission('customers.manage'), validate(z.object({ status: z.enum(['new', 'in_progress', 'resolved', 'spam']) })), async (req, res) => res.json({ data: await operations.updateContactMessage(req.params.id, req.body.status, req.auth.user.id, req), meta: null, requestId: req.id }));
