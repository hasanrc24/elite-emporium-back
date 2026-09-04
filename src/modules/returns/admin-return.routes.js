import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as refunds from '../payments/refund.service.js';
import * as returns from './admin-return.service.js';

export const adminReturnRouter = Router();
const moneyValue = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const version = z.number().int().positive();

adminReturnRouter.use(authenticate);
adminReturnRouter.get('/returns', requirePermission('returns.view'), async (req, res) => {
  const result = await returns.listAdminReturns(req.query);
  res.json({ ...result, requestId: req.id });
});
adminReturnRouter.get('/returns/:id', requirePermission('returns.view'), async (req, res) => {
  res.json({ data: await returns.getAdminReturn(req.params.id), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/review', requirePermission('returns.manage'), validate(z.object({ version, message: z.string().trim().max(500).optional(), note: z.string().trim().max(1000).optional(), public: z.boolean().default(true) })), async (req, res) => {
  res.json({ data: await returns.startReview(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/approve', requirePermission('returns.manage'), validate(z.object({ version, refundAmount: moneyValue.nullable().optional(), message: z.string().trim().max(500).optional(), note: z.string().trim().max(1000).optional() })), async (req, res) => {
  res.json({ data: await returns.approveReturn(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/reject', requirePermission('returns.manage'), validate(z.object({ version, reason: z.string().trim().min(3).max(500), message: z.string().trim().max(500).optional(), internalNote: z.string().trim().max(1000).optional() })), async (req, res) => {
  res.json({ data: await returns.rejectReturn(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/in-transit', requirePermission('returns.manage'), validate(z.object({ version, courier: z.string().trim().max(160).optional(), trackingNumber: z.string().trim().max(190).optional(), trackingUrl: z.string().url().max(1000).optional(), message: z.string().trim().max(500).optional() })), async (req, res) => {
  res.json({ data: await returns.markReturnInTransit(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/receive', requirePermission('returns.manage'), validate(z.object({ version, receivedAt: z.iso.datetime().optional(), message: z.string().trim().max(500).optional(), note: z.string().trim().max(1000).optional() })), async (req, res) => {
  res.json({ data: await returns.receiveReturn(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/inspect', requirePermission('returns.manage'), validate(z.object({
  version,
  publicMessage: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    returnItemId: z.string().length(26),
    condition: z.enum(['new', 'opened', 'used', 'damaged', 'defective', 'unsellable']),
    restock: z.boolean(),
    locationId: z.string().length(26).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  }).superRefine((value, context) => {
    if (value.restock && !value.locationId) context.addIssue({ code: 'custom', path: ['locationId'], message: 'Choose a stock location when restocking.' });
  })).min(1).max(50),
})), async (req, res) => {
  res.json({ data: await returns.inspectReturn(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/refund', requirePermission('returns.manage'), requirePermission('payments.refund'), validate(z.object({ paymentId: z.string().length(26), amount: moneyValue, method: z.enum(['manual', 'bkash']), reason: z.string().trim().min(3).max(500), sku: z.string().trim().min(1).max(100).optional(), note: z.string().trim().max(1000).optional() })), async (req, res) => {
  const data = await refunds.createRefund(req.body.paymentId, { ...req.body, returnId: req.params.id }, req.auth.user.id, req.get('idempotency-key'), req);
  res.status(201).json({ data, meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/exchange', requirePermission('returns.manage'), validate(z.object({ version, items: z.array(z.object({ variantId: z.string().length(26), quantity: z.number().int().min(1).max(999) })).min(1).max(50), note: z.string().trim().max(1000).optional() })), async (req, res) => {
  res.status(201).json({ data: await returns.createExchangeDraft(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/complete', requirePermission('returns.manage'), validate(z.object({ version, message: z.string().trim().max(500).optional() })), async (req, res) => {
  res.json({ data: await returns.completeReturn(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminReturnRouter.post('/returns/:id/events', requirePermission('returns.manage'), validate(z.object({ type: z.string().trim().min(1).max(100), message: z.string().trim().min(1).max(500), public: z.boolean().default(false), metadata: z.record(z.string(), z.unknown()).nullable().optional() })), async (req, res) => {
  res.status(201).json({ data: await returns.addReturnEvent(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});

