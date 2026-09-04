import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, optionalAuthenticate } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as wishlists from './wishlist.service.js';

export const wishlistRouter = Router();
const cookie = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE, path: '/', signed: true, maxAge: 90 * 86400000 };
const locale = (req) => ['en', 'bn'].includes(req.query.locale) ? req.query.locale : 'en';

wishlistRouter.post('/merge', authenticate, async (req, res) => {
  const token = req.signedCookies[wishlists.WISHLIST_COOKIE];
  const { wishlist } = await wishlists.resolveWishlist(null, req.auth.user.id, true);
  await wishlists.mergeGuestWishlist(wishlist.id, token);
  res.clearCookie(wishlists.WISHLIST_COOKIE, { ...cookie, maxAge: undefined });
  res.json({ data: await wishlists.getWishlist(wishlist.id, locale(req)), meta: null, requestId: req.id });
});
wishlistRouter.use(optionalAuthenticate, async (req, res, next) => {
  try {
    const { wishlist, issuedToken } = await wishlists.resolveWishlist(req.signedCookies[wishlists.WISHLIST_COOKIE], req.auth?.user.id, true);
    if (issuedToken && !req.auth) res.cookie(wishlists.WISHLIST_COOKIE, issuedToken, cookie);
    req.wishlist = wishlist;
    next();
  } catch (error) { next(error); }
});
wishlistRouter.get('/', async (req, res) => res.json({ data: await wishlists.getWishlist(req.wishlist.id, locale(req)), meta: null, requestId: req.id }));
wishlistRouter.post('/items', validate(z.object({ productId: z.string().length(26), variantId: z.string().length(26).nullable().optional() })), async (req, res) => { await wishlists.addWishlistItem(req.wishlist.id, req.body); res.status(201).json({ data: await wishlists.getWishlist(req.wishlist.id, locale(req)), meta: null, requestId: req.id }); });
wishlistRouter.delete('/items/:id', async (req, res) => { await wishlists.removeWishlistItem(req.wishlist.id, req.params.id); res.json({ data: await wishlists.getWishlist(req.wishlist.id, locale(req)), meta: null, requestId: req.id }); });
