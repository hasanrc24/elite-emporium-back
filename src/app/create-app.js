import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { metricsHandler, metricsMiddleware } from '../lib/metrics.js';
import { redis } from '../lib/redis.js';
import { liveHealth, readyHealth, versionInfo } from './health.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { catalogRouter, adminCatalogRouter } from '../modules/catalog/catalog.routes.js';
import { cartRouter } from '../modules/cart/cart.routes.js';
import { checkoutRouter, orderRouter } from '../modules/orders/order.routes.js';
import { settingsRouter, storefrontRouter } from '../modules/settings/settings.routes.js';
import { adminRouter } from '../modules/admin/admin.routes.js';
import { adminMediaRouter, mediaRouter } from '../modules/media/media.routes.js';
import { userRouter } from '../modules/users/user.routes.js';
import { adminTaxonomyRouter } from '../modules/catalog/taxonomy.routes.js';
import { adminInventoryRouter } from '../modules/inventory/inventory.routes.js';
import { paymentRouter } from '../modules/payments/payment.routes.js';
import { adminIntegrationRouter } from '../modules/integrations/integration.routes.js';
import { adminOrderRouter } from '../modules/orders/admin-order.routes.js';
import { adminShippingRouter } from '../modules/shipping/admin-shipping.routes.js';
import { wishlistRouter } from '../modules/wishlist/wishlist.routes.js';
import { adminReviewRouter, reviewRouter } from '../modules/reviews/review.routes.js';
import { adminRefundRouter } from '../modules/payments/refund.routes.js';
import { returnRouter } from '../modules/returns/return.routes.js';
import { adminReturnRouter } from '../modules/returns/admin-return.routes.js';
import { adminProductRouter } from '../modules/catalog/admin-product.routes.js';
import { adminCouponRouter } from '../modules/promotions/admin-coupon.routes.js';
import { adminStaffRouter } from '../modules/admin/staff.routes.js';
import { adminContentRouter, contentRouter } from '../modules/content/content.routes.js';
import { adminCustomerRouter } from '../modules/admin/customer.routes.js';
import { adminOperationsRouter } from '../modules/admin/operations.routes.js';

export function createApp() {
  const app = express();
  const api = env.API_BASE_PATH;
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(pinoHttp({ logger, genReqId: (req, res) => { const suppliedId = req.headers['x-request-id']; const id = typeof suppliedId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(suppliedId) ? suppliedId : newId(); res.setHeader('X-Request-Id', id); return id; } }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.PUBLIC_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(env.COOKIE_SIGNING_SECRET));
  app.use(metricsMiddleware);

  // Only the public subtree is web-accessible. Private originals and derived
  // files remain outside this mount and require an expiring signed API URL.
  app.use('/media/public', express.static(path.resolve(env.MEDIA_ROOT, 'public'), {
    dotfiles: 'deny',
    etag: true,
    fallthrough: true,
    immutable: true,
    index: false,
    maxAge: '365d',
  }));

  /** @type {import('rate-limit-redis').SendCommandFn} */
  const sendRedisCommand = async (command, ...args) => (
    /** @type {import('rate-limit-redis').RedisReply} */ (await redis.call(command, ...args))
  );
  const rateStore = env.REDIS_OPTIONAL ? undefined : new RedisStore({ prefix: 'rate:auth:', sendCommand: sendRedisCommand });
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: 'draft-8', legacyHeaders: false, store: rateStore });
  const limited = (prefix, limit) => rateLimit({ windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : limit, standardHeaders: 'draft-8', legacyHeaders: false, store: env.REDIS_OPTIONAL ? undefined : new RedisStore({ prefix: `rate:${prefix}:`, sendCommand: sendRedisCommand }) });
  app.get(`${api}/health/live`, liveHealth);
  app.get(`${api}/health/ready`, readyHealth);
  app.get(`${api}/version`, versionInfo);
  app.get(`${api}/metrics`, metricsHandler);
  const openapi = YAML.parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
  app.get(`${api}/openapi.json`, (req, res) => res.json(openapi));
  app.use(`${api}/docs`, swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Elite Emporium API' }));
  app.use(`${api}/auth`, authLimiter, authRouter);
  app.use(`${api}/storefront`, storefrontRouter);
  app.use(api, contentRouter);
  app.use(api, catalogRouter);
  app.use(`${api}/carts`, cartRouter);
  app.use(`${api}/checkout`, limited('checkout', 30));
  app.use(`${api}/checkout`, checkoutRouter);
  app.post(`${api}/orders`, limited('order-create', 20));
  app.post(`${api}/orders/track`, limited('order-track', 20));
  app.use(`${api}/orders`, orderRouter);
  app.post(`${api}/payments/bkash/create`, limited('payment-create', 20));
  app.post(`${api}/payments/bkash/recover`, limited('payment-recover', 200));
  app.get(`${api}/payments/bkash/callback`, limited('payment-callback', 100));
  app.use(`${api}/payments`, paymentRouter);
  app.use(`${api}/wishlist`, wishlistRouter);
  app.use(`${api}/returns`, returnRouter);
  app.post(`${api}/reviews`, limited('review', 20));
  app.use(api, reviewRouter);
  app.use(`${api}/users`, userRouter);
  app.use(`${api}/media`, mediaRouter);
  app.use(`${api}/admin/media`, adminMediaRouter);
  app.use(`${api}/admin`, adminRouter);
  app.use(`${api}/admin`, adminTaxonomyRouter);
  app.use(`${api}/admin`, adminInventoryRouter);
  app.use(`${api}/admin`, adminIntegrationRouter);
  app.use(`${api}/admin`, adminOrderRouter);
  app.use(`${api}/admin`, adminShippingRouter);
  app.use(`${api}/admin`, adminReviewRouter);
  app.use(`${api}/admin`, adminRefundRouter);
  app.use(`${api}/admin`, adminReturnRouter);
  app.use(`${api}/admin`, adminProductRouter);
  app.use(`${api}/admin`, adminCouponRouter);
  app.use(`${api}/admin`, adminStaffRouter);
  app.use(`${api}/admin`, adminCustomerRouter);
  app.use(`${api}/admin`, adminOperationsRouter);
  app.use(`${api}/admin`, adminContentRouter);
  app.use(`${api}/admin`, adminCatalogRouter);
  app.use(`${api}/admin/settings`, settingsRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
