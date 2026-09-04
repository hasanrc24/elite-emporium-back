import { Router } from 'express';
import { z } from 'zod';
import { authenticate, optionalAuthenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import { cartContext } from '../cart/cart.routes.js';
import * as orders from './order.service.js';

export const checkoutRouter = Router();
export const orderRouter = Router();

const customer = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().min(10).max(30), email: z.union([z.literal(''), z.email().max(190)]).optional().default('') });
const address = z.object({ recipientName: z.string().trim().min(2).max(120), phone: z.string().trim().min(10).max(30).optional(), addressLine: z.string().trim().min(5).max(500), area: z.string().trim().max(120).nullable().optional(), district: z.string().trim().max(120).nullable().optional(), division: z.string().trim().max(120).nullable().optional(), postcode: z.string().trim().max(20).nullable().optional(), landmark: z.string().trim().max(255).nullable().optional() });
const quoteSchema = z.object({ customer, address, billingAddress: address.nullable().optional(), deliveryCode: z.string().trim().min(1).max(60), paymentMethod: z.enum(['cod', 'bkash']).default('cod'), locale: z.enum(['en', 'bn']).default('en'), note: z.string().trim().max(1000).optional().default('') });
const orderSchema = z.object({ quoteId: z.string().length(26) });

checkoutRouter.use(optionalAuthenticate, cartContext);
checkoutRouter.post('/quote', validate(quoteSchema), async (req, res) => res.json({ data: await orders.quote(req.cart.id, req.auth?.user.id, req.body), meta: null, requestId: req.id }));

orderRouter.post('/', optionalAuthenticate, cartContext, validate(orderSchema), async (req, res) => res.status(201).json({ data: await orders.createOrder(req.cart.id, req.auth?.user.id, req.body, req.get('idempotency-key'), req), meta: null, requestId: req.id }));
orderRouter.post('/track', validate(z.object({ reference: z.string().trim().min(5).max(40), phone: z.string().min(10).max(30) })), async (req, res) => res.json({ data: await orders.trackOrder(req.body.reference, req.body.phone), meta: null, requestId: req.id }));
orderRouter.get('/', authenticate, async (req, res) => { const result = await orders.listOrders(req.auth.user.id, req.query); res.json({ ...result, requestId: req.id }); });
orderRouter.get('/:id', authenticate, async (req, res) => res.json({ data: await orders.getOrder(req.params.id, req.auth.user.id), meta: null, requestId: req.id }));
orderRouter.post('/:id/cancel', authenticate, validate(z.object({ reason: z.string().trim().min(3).max(255) })), async (req, res) => res.json({ data: await orders.cancelOrder(req.params.id, req.auth.user.id, req.body.reason, req), meta: null, requestId: req.id }));
