import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as customers from './customer.service.js';
import * as privacy from '../users/privacy.service.js';

export const adminCustomerRouter = Router();
adminCustomerRouter.use(authenticate);

adminCustomerRouter.get('/customers', requirePermission('customers.view'), async (req, res) => {
  const result = await customers.listCustomers(req.query);
  res.json({ ...result, requestId: req.id });
});
adminCustomerRouter.get('/customers/:id', requirePermission('customers.view'), async (req, res) => res.json({ data: await customers.getCustomer(req.params.id), meta: null, requestId: req.id }));
adminCustomerRouter.patch('/customers/:id', requirePermission('customers.manage'), validate(z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email().max(190).nullable().optional(),
  locale: z.enum(['en', 'bn']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  riskLevel: z.enum(['normal', 'review', 'blocked']).optional(),
  reason: z.string().trim().min(3).max(500),
  customerMessage: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
})), async (req, res) => res.json({ data: await customers.updateCustomer(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminCustomerRouter.post('/customers/:id/notes', requirePermission('customers.manage'), validate(z.object({
  category: z.enum(['support', 'risk', 'operations']).default('support'),
  message: z.string().trim().min(1).max(5000),
})), async (req, res) => res.status(201).json({ data: await customers.addCustomerNote(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));

adminCustomerRouter.get('/privacy-requests', requirePermission('customers.view'), async (req, res) => {
  const result = await privacy.listAdminPrivacyRequests(req.query);
  res.json({ ...result, requestId: req.id });
});
adminCustomerRouter.get('/privacy-requests/:id', requirePermission('customers.view'), async (req, res) => res.json({ data: await privacy.getAdminPrivacyRequest(req.params.id), meta: null, requestId: req.id }));
adminCustomerRouter.post('/privacy-requests/:id/transitions', requirePermission('customers.manage'), validate(z.object({
  status: z.enum(['under_review', 'approved', 'rejected', 'completed']),
  version: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  customerMessage: z.string().trim().max(500).optional(),
  confirmation: z.string().trim().max(80).optional(),
})), async (req, res) => res.json({ data: await privacy.transitionPrivacyRequest(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
