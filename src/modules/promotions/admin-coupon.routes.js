import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as coupons from './admin-coupon.service.js';

export const adminCouponRouter = Router();
adminCouponRouter.use(authenticate, requirePermission('promotions.manage'));

const id = z.string().length(26);
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
const couponSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).min(2).max(80),
  type: z.enum(['percentage', 'fixed_cart', 'fixed_item', 'free_delivery']),
  amount: money,
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  minimumSpend: money.nullable().optional(),
  maximumSpend: money.nullable().optional(),
  usageLimit: z.number().int().positive().max(100_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  perItemLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  includeSaleItems: z.boolean().default(true),
  firstOrderOnly: z.boolean().default(false),
  stackable: z.boolean().default(false),
  allowedZones: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  allowedPayments: z.array(z.enum(['cod', 'bkash'])).max(2).default([]),
  active: z.boolean().default(true),
  includedProductIds: z.array(id).max(10_000).default([]),
  excludedProductIds: z.array(id).max(10_000).default([]),
  includedCategoryIds: z.array(id).max(1_000).default([]),
  excludedCategoryIds: z.array(id).max(1_000).default([]),
  eligibleUserIds: z.array(id).max(10_000).default([]),
  eligiblePhones: z.array(z.string().trim().min(10).max(30)).max(10_000).default([]),
});

adminCouponRouter.get('/coupons', async (req, res) => {
  const result = await coupons.listCoupons(req.query);
  res.json({ ...result, requestId: req.id });
});
adminCouponRouter.post('/coupons', validate(couponSchema), async (req, res) => {
  res.status(201).json({ data: await coupons.createCoupon(req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminCouponRouter.get('/coupons/:id', async (req, res) => {
  res.json({ data: await coupons.getCoupon(req.params.id), meta: null, requestId: req.id });
});
adminCouponRouter.patch('/coupons/:id', validate(couponSchema.and(z.object({ version: z.number().int().positive() }))), async (req, res) => {
  res.json({ data: await coupons.updateCoupon(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminCouponRouter.post('/coupons/:id/activation', validate(z.object({ version: z.number().int().positive(), active: z.boolean() })), async (req, res) => {
  res.json({ data: await coupons.setCouponActive(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminCouponRouter.post('/coupons/:id/archive', validate(z.object({ version: z.number().int().positive() })), async (req, res) => {
  await coupons.archiveCoupon(req.params.id, req.body.version, req.auth.user.id, req);
  res.status(204).end();
});
adminCouponRouter.post('/coupons/:id/restore', async (req, res) => {
  res.json({ data: await coupons.restoreCoupon(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminCouponRouter.post('/coupons/:id/duplicate', validate(z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).min(2).max(80) })), async (req, res) => {
  res.status(201).json({ data: await coupons.duplicateCoupon(req.params.id, req.body.code, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminCouponRouter.get('/coupons/:id/usage', async (req, res) => {
  const result = await coupons.listCouponUsage(req.params.id, req.query);
  res.json({ ...result, requestId: req.id });
});

