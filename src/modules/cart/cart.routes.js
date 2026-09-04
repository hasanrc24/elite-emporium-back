import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, optionalAuthenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as carts from './cart.service.js';

export const cartRouter = Router();

const cartCookie = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE, path: '/', signed: true, maxAge: 30 * 86400000 };
const locale = (req) => ['en', 'bn'].includes(req.query.locale) ? req.query.locale : 'en';

export async function cartContext(req, res, next) {
  try {
    const token = req.signedCookies[carts.CART_COOKIE];
    const { cart, issuedToken } = await carts.resolveCart(token, req.auth?.user.id, true);
    if (issuedToken && !req.auth) res.cookie(carts.CART_COOKIE, issuedToken, cartCookie);
    req.cart = cart;
    next();
  } catch (error) { next(error); }
}

cartRouter.post('/merge', authenticate, async (req, res) => {
  const guestToken = req.signedCookies[carts.CART_COOKIE];
  const { cart } = await carts.resolveCart(null, req.auth.user.id, true);
  const merge = await carts.mergeGuestCart(cart.id, guestToken);
  res.clearCookie(carts.CART_COOKIE, { ...cartCookie, maxAge: undefined });
  res.json({ data: { cart: await carts.getCart(cart.id, locale(req), req.auth.user.id), changes: merge.changes }, meta: null, requestId: req.id });
});

cartRouter.use(optionalAuthenticate, cartContext);
cartRouter.post('/', async (req, res) => res.status(201).json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }));
cartRouter.get('/current', async (req, res) => res.json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }));
cartRouter.post('/items', validate(z.object({ variantId: z.string().length(26), quantity: z.number().int().min(1).max(99) })), async (req, res) => { await carts.addItem(req.cart.id, req.body); res.status(201).json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }); });
cartRouter.patch('/items/:id', validate(z.object({ quantity: z.number().int().min(0).max(99), version: z.number().int().positive().optional() })), async (req, res) => { await carts.updateItem(req.cart.id, req.params.id, req.body.quantity, req.body.version); res.json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }); });
cartRouter.delete('/items/:id', async (req, res) => { await carts.removeItem(req.cart.id, req.params.id); res.json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }); });
cartRouter.post('/coupons', validate(z.object({ code: z.string().trim().min(1).max(80) })), async (req, res) => { await carts.applyCoupon(req.cart.id, req.body.code, req.auth?.user.id); res.json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }); });
cartRouter.delete('/coupons/:code', async (req, res) => { await carts.removeCoupon(req.cart.id, req.params.code); res.json({ data: await carts.getCart(req.cart.id, locale(req), req.auth?.user.id), meta: null, requestId: req.id }); });
