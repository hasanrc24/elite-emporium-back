import { Router } from 'express';
import { z } from 'zod';
import { optionalAuthenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import { cartContext } from '../cart/cart.routes.js';
import * as payments from './payment.service.js';

export const paymentRouter = Router();

paymentRouter.post('/bkash/create', optionalAuthenticate, cartContext, validate(z.object({ quoteId: z.string().length(26) })), async (req, res) => res.json({ data: await payments.startBkashPayment(req.cart.id, req.auth?.user.id, req.body, req.get('idempotency-key'), req), meta: null, requestId: req.id }));
paymentRouter.get('/bkash/callback', validate(z.object({ paymentID: z.string().trim().min(1).max(190), status: z.enum(['success', 'failure', 'cancel']) }), 'query'), async (req, res) => res.json({ data: await payments.processBkashCallback(req.query.paymentID, req.query.status), meta: null, requestId: req.id }));
paymentRouter.post('/bkash/recover', validate(z.object({ attemptId: z.string().length(26), recoveryToken: z.string().min(32).max(200), callbackStatus: z.enum(['success', 'failure', 'cancel']).nullable().optional() })), async (req, res) => res.json({ data: await payments.recoverBkashPayment(req.body), meta: null, requestId: req.id }));
