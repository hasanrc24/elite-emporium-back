import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as reviews from './review.service.js';

export const reviewRouter = Router();
export const adminReviewRouter = Router();
const reviewBody = z.object({ productId: z.string().length(26), orderItemId: z.string().length(26), rating: z.number().int().min(1).max(5), title: z.string().trim().max(180).optional().default(''), body: z.string().trim().min(1).max(5000), mediaIds: z.array(z.string().length(26)).max(5).default([]) });
reviewRouter.get('/products/:id/reviews', async (req, res) => { const result = await reviews.listPublicReviews(req.params.id, req.query); res.json({ ...result, requestId: req.id }); });
reviewRouter.get('/reviews', authenticate, async (req, res) => { const result = await reviews.listOwnReviews(req.auth.user.id, req.query); res.json({ ...result, requestId: req.id }); });
reviewRouter.post('/reviews', authenticate, validate(reviewBody), async (req, res) => res.status(201).json({ data: await reviews.createReview(req.auth.user.id, req.body, req), meta: null, requestId: req.id }));
reviewRouter.patch('/reviews/:id', authenticate, validate(reviewBody.omit({ productId: true, orderItemId: true }).and(z.object({ version: z.number().int().positive() }))), async (req, res) => res.json({ data: await reviews.updateReview(req.auth.user.id, req.params.id, req.body, req), meta: null, requestId: req.id }));
reviewRouter.delete('/reviews/:id', authenticate, async (req, res) => { await reviews.deleteReview(req.auth.user.id, req.params.id, req); res.status(204).end(); });

adminReviewRouter.use(authenticate, requirePermission('reviews.moderate'));
adminReviewRouter.get('/reviews', async (req, res) => { const result = await reviews.listAdminReviews(req.query); res.json({ ...result, requestId: req.id }); });
adminReviewRouter.post('/reviews/:id/moderate', validate(z.object({ status: z.enum(['approved', 'rejected', 'spam']), reason: z.string().trim().min(3).max(500), version: z.number().int().positive() })), async (req, res) => res.json({ data: await reviews.moderateReview(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminReviewRouter.post('/reviews/:id/respond', validate(z.object({ response: z.string().trim().min(1).max(2000) })), async (req, res) => res.json({ data: await reviews.respondToReview(req.params.id, req.body.response, req.auth.user.id, req), meta: null, requestId: req.id }));
