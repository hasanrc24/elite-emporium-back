import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import { publicUser } from '../auth/auth.service.js';
import * as users from './user.service.js';
import * as privacy from './privacy.service.js';

export const userRouter = Router();
userRouter.use(authenticate);

const addressFields = {
  label: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(11).max(30),
  addressLine: z.string().trim().min(5).max(500),
  area: z.string().trim().max(120).nullable().optional(),
  district: z.string().trim().max(120).nullable().optional(),
  division: z.string().trim().max(120).nullable().optional(),
  postcode: z.string().trim().max(20).nullable().optional(),
  landmark: z.string().trim().max(255).nullable().optional(),
  isDefaultShipping: z.boolean().optional().default(false),
  isDefaultBilling: z.boolean().optional().default(false),
};
const createAddressSchema = z.object(addressFields);
const updateAddressSchema = z.object({ ...addressFields, version: z.number().int().positive() });

userRouter.get('/me', async (req, res) => res.json({ data: publicUser(req.auth.user), meta: null, requestId: req.id }));
userRouter.patch('/me', validate(z.object({ name: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(30).nullable().optional(), email: z.string().trim().email().max(190).nullable().optional(), locale: z.enum(['en', 'bn']).optional(), currentPassword: z.string().max(128).optional(), version: z.number().int().positive() })), async (req, res) => res.json({ data: await users.updateProfile(req.auth.user.id, req.auth.session.id, req.body, req), meta: null, requestId: req.id }));
userRouter.get('/me/addresses', async (req, res) => res.json({ data: await users.listAddresses(req.auth.user.id), meta: null, requestId: req.id }));
userRouter.post('/me/addresses', validate(createAddressSchema), async (req, res) => res.status(201).json({ data: await users.createAddress(req.auth.user.id, req.body, req), meta: null, requestId: req.id }));
userRouter.patch('/me/addresses/:id', validate(updateAddressSchema), async (req, res) => res.json({ data: await users.updateAddress(req.auth.user.id, req.params.id, req.body, req), meta: null, requestId: req.id }));
userRouter.delete('/me/addresses/:id', async (req, res) => { await users.deleteAddress(req.auth.user.id, req.params.id, req); res.status(204).end(); });
userRouter.get('/me/privacy-requests', async (req, res) => res.json({ data: await privacy.listOwnPrivacyRequests(req.auth.user.id), meta: null, requestId: req.id }));
userRouter.post('/me/privacy-requests', validate(z.object({
  type: z.enum(['export', 'deletion']),
  note: z.string().trim().max(500).optional(),
  currentPassword: z.string().max(128).optional(),
  confirmation: z.string().max(80).optional(),
})), async (req, res) => res.status(201).json({ data: await privacy.createPrivacyRequest(req.auth.user.id, req.body, req), meta: null, requestId: req.id }));
