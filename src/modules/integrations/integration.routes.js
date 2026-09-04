import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as integrations from './integration.service.js';

export const adminIntegrationRouter = Router();
adminIntegrationRouter.use(authenticate, requirePermission('integrations.manage'));
adminIntegrationRouter.get('/integrations', async (req, res) => res.json({ data: await integrations.listIntegrations(), meta: null, requestId: req.id }));
adminIntegrationRouter.put('/integrations/bkash', validate(z.object({ environment: z.enum(['sandbox', 'live']), username: z.string().trim().min(1).max(255), password: z.string().min(1).max(255), appKey: z.string().trim().min(1).max(255), appSecret: z.string().min(1).max(255), version: z.number().int().positive().nullable().optional() })), async (req, res) => res.json({ data: await integrations.configureBkash(req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminIntegrationRouter.post('/integrations/bkash/test', async (req, res) => res.json({ data: await integrations.testBkash(req.auth.user.id, req), meta: null, requestId: req.id }));
adminIntegrationRouter.post('/integrations/bkash/enable', async (req, res) => res.json({ data: await integrations.setBkashEnabled(true, req.auth.user.id, req), meta: null, requestId: req.id }));
adminIntegrationRouter.post('/integrations/bkash/disable', async (req, res) => res.json({ data: await integrations.setBkashEnabled(false, req.auth.user.id, req), meta: null, requestId: req.id }));

const baseMessaging = { environment: z.literal('default').default('default'), version: z.number().int().positive().nullable().optional() };
const messagingSchemas = {
  smtp: z.object({ ...baseMessaging, host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), secure: z.boolean(), username: z.string().max(255).optional(), password: z.string().max(1000).optional(), from: z.email().max(255) }),
  sms: z.object({ ...baseMessaging, url: z.url().max(1000), token: z.string().max(2000).optional(), tokenHeader: z.string().regex(/^[A-Za-z0-9-]+$/).max(100).optional(), tokenScheme: z.string().max(30).optional(), recipientField: z.string().regex(/^[A-Za-z0-9_]+$/).max(80).optional(), messageField: z.string().regex(/^[A-Za-z0-9_]+$/).max(80).optional() }),
};
for (const provider of ['smtp', 'sms']) {
  adminIntegrationRouter.put(`/integrations/${provider}`, validate(messagingSchemas[provider]), async (req, res) => res.json({ data: await integrations.configureMessaging(provider, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminIntegrationRouter.post(`/integrations/${provider}/test`, validate(z.object({ environment: z.literal('default').default('default'), testRecipient: provider === 'sms' ? z.string().trim().min(6).max(30) : z.string().optional() })), async (req, res) => res.json({ data: await integrations.testMessaging(provider, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminIntegrationRouter.post(`/integrations/${provider}/enable`, async (req, res) => res.json({ data: await integrations.setMessagingEnabled(provider, true, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminIntegrationRouter.post(`/integrations/${provider}/disable`, async (req, res) => res.json({ data: await integrations.setMessagingEnabled(provider, false, req.auth.user.id, req), meta: null, requestId: req.id }));
}
