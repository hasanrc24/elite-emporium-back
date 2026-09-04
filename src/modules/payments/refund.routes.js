import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as refunds from './refund.service.js';

export const adminRefundRouter = Router();

const moneyValue = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const createRefundSchema = z.object({
  amount: moneyValue,
  reason: z.string().trim().min(3).max(500),
  method: z.enum(['manual', 'bkash']),
  returnId: z.string().length(26).nullable().optional(),
  sku: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(1000).optional(),
});

adminRefundRouter.use(authenticate);
adminRefundRouter.get('/refunds', requirePermission('payments.view'), async (req, res) => {
  const result = await refunds.listRefunds(req.query);
  res.json({ ...result, requestId: req.id });
});
adminRefundRouter.get('/refunds/:id', requirePermission('payments.view'), async (req, res) => {
  res.json({ data: await refunds.getRefund(req.params.id), meta: null, requestId: req.id });
});
adminRefundRouter.get('/payments/:id/refund-capacity', requirePermission('payments.view'), async (req, res) => {
  res.json({ data: await refunds.getPaymentRefundCapacity(req.params.id), meta: null, requestId: req.id });
});
adminRefundRouter.post('/payments/:id/refunds', requirePermission('payments.refund'), validate(createRefundSchema), async (req, res) => {
  const data = await refunds.createRefund(req.params.id, req.body, req.auth.user.id, req.get('idempotency-key'), req);
  res.status(201).json({ data, meta: null, requestId: req.id });
});
adminRefundRouter.post('/refunds/:id/complete', requirePermission('payments.refund'), validate(z.object({
  reference: z.string().trim().min(1).max(190),
  completedAt: z.iso.datetime().optional(),
  note: z.string().trim().max(1000).optional(),
})), async (req, res) => {
  res.json({ data: await refunds.completeManualRefund(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminRefundRouter.post('/refunds/:id/cancel', requirePermission('payments.refund'), validate(z.object({
  reason: z.string().trim().min(3).max(500),
})), async (req, res) => {
  res.json({ data: await refunds.cancelRefund(req.params.id, req.body.reason, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminRefundRouter.post('/refunds/:id/reconcile', requirePermission('payments.reconcile'), async (req, res) => {
  res.json({ data: await refunds.reconcileBkashRefund(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id });
});

