import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, optionalAuthenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as media from '../media/media.service.js';
import * as returns from './return.service.js';

export const returnRouter = Router();

const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(env.MEDIA_MAX_IMAGE_BYTES, env.MEDIA_MAX_DOCUMENT_BYTES), files: 1, fields: 10 },
});
const guestCredentials = z.object({
  orderReference: z.string().trim().min(5).max(40),
  phone: z.string().trim().min(10).max(30),
});
const createReturnSchema = z.object({
  orderId: z.string().length(26).optional(),
  orderReference: z.string().trim().min(5).max(40).optional(),
  phone: z.string().trim().min(10).max(30).optional(),
  type: z.enum(['return', 'exchange']),
  resolution: z.enum(['refund', 'exchange']),
  reason: z.string().trim().min(3).max(255),
  customerNote: z.string().trim().max(5000).optional(),
  items: z.array(z.object({
    orderItemId: z.string().length(26),
    quantity: z.number().int().min(1).max(999),
    reason: z.string().trim().min(3).max(255).optional(),
  })).min(1).max(50),
  mediaIds: z.array(z.string().length(26)).max(10).default([]),
}).superRefine((value, context) => {
  if (!value.orderId && (!value.orderReference || !value.phone)) context.addIssue({ code: 'custom', path: ['orderReference'], message: 'Order reference and phone are required for a guest return.' });
});

returnRouter.get('/eligibility', authenticate, validate(z.object({ orderId: z.string().length(26) }), 'query'), async (req, res) => {
  res.json({ data: await returns.getReturnEligibility({ orderId: req.query.orderId, userId: req.auth.user.id }), meta: null, requestId: req.id });
});
returnRouter.post('/guest-eligibility', guestLimiter, validate(guestCredentials), async (req, res) => {
  res.json({ data: await returns.getReturnEligibility({ orderReference: req.body.orderReference, phone: req.body.phone, userId: null }), meta: null, requestId: req.id });
});
returnRouter.post('/guest-upload', guestLimiter, upload.single('file'), validate(guestCredentials.extend({ altText: z.string().trim().max(500).optional() })), async (req, res) => {
  const request = /** @type {any} */ (req);
  const order = await returns.verifyGuestReturnUpload(req.body.orderReference, req.body.phone);
  const data = await media.uploadMedia({
    file: request.file,
    privacy: 'private',
    altText: req.body.altText,
    actorId: null,
    request: req,
    purpose: 'return',
    metadata: { guestOrderId: order.id },
  });
  res.status(201).json({ data, meta: null, requestId: req.id });
});
returnRouter.post('/guest-lookup', guestLimiter, validate(guestCredentials.extend({ returnReference: z.string().trim().min(5).max(40).optional() })), async (req, res) => {
  res.json({ data: await returns.guestLookup(req.body), meta: null, requestId: req.id });
});
returnRouter.post('/', optionalAuthenticate, validate(createReturnSchema), async (req, res) => {
  const data = await returns.createReturn(req.body, req.auth?.user.id || null, req.get('idempotency-key'), req);
  res.status(201).json({ data, meta: null, requestId: req.id });
});
returnRouter.get('/', authenticate, async (req, res) => {
  const result = await returns.listReturns(req.auth.user.id, req.query);
  res.json({ ...result, requestId: req.id });
});
returnRouter.get('/:id', authenticate, async (req, res) => {
  res.json({ data: await returns.getReturn(req.params.id, req.auth.user.id), meta: null, requestId: req.id });
});
returnRouter.post('/:id/cancel', optionalAuthenticate, validate(z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  orderReference: z.string().trim().min(5).max(40).optional(),
  phone: z.string().trim().min(10).max(30).optional(),
})), async (req, res) => {
  res.json({ data: await returns.cancelReturn(req.params.id, req.body, req.auth?.user.id || null, req), meta: null, requestId: req.id });
});

