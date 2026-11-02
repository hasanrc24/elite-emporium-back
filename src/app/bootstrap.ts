import "reflect-metadata";
import compression from "compression";
import cookieParser from "cookie-parser";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { AppModule } from "./app.module.js";
import { AppErrorFilter } from "./app-error.filter.js";
import { openapiDocument } from "./core.controller.js";
import { env } from "../config/env.js";
import { newId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { metricsMiddleware } from "../lib/metrics.js";
import { redis } from "../lib/redis.js";

const sendRedisCommand = async (command: string, ...args: string[]) =>
  (await redis.call(command, ...args)) as never;
const store = (prefix: string) =>
  env.REDIS_OPTIONAL
    ? undefined
    : new RedisStore({
        prefix: `rate:${prefix}:`,
        sendCommand: sendRedisCommand,
      });
const limiter = (prefix: string, limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.NODE_ENV === "test" ? 1000 : limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: store(prefix),
  });

export async function createNestApplication(): Promise<NestExpressApplication> {
  const server: Express = express();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
    {
      bodyParser: false,
      bufferLogs: true,
    },
  );
  if (env.TRUST_PROXY) server.set("trust proxy", 1);
  app.useLogger({
    log: (message) => logger.info(message),
    error: (message, trace) => logger.error({ trace }, message),
    warn: (message) => logger.warn(message),
    debug: (message) => logger.debug(message),
    verbose: (message) => logger.trace(message),
    fatal: (message) => logger.fatal(message),
  });
  app.setGlobalPrefix(env.API_BASE_PATH.replace(/^\//, ""));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const supplied = req.headers["x-request-id"];
        const id =
          typeof supplied === "string" &&
          /^[A-Za-z0-9_-]{8,100}$/.test(supplied)
            ? supplied
            : newId();
        res.setHeader("X-Request-Id", id);
        return id;
      },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.enableCors({
    origin: env.PUBLIC_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser(env.COOKIE_SIGNING_SECRET));
  app.use(metricsMiddleware);
  app.useStaticAssets(path.resolve(env.MEDIA_ROOT, "public"), {
    prefix: "/media/public/",
    dotfiles: "deny",
    etag: true,
    fallthrough: true,
    immutable: true,
    index: false,
    maxAge: "365d",
  });

  const api = env.API_BASE_PATH;
  // Limiters are built once: constructing them per request resets memory-store
  // counters every time and re-registers Redis scripts on each call.
  const credentialLimiter = limiter("auth", 30);
  // Refresh runs on every full page load and before each access-token expiry,
  // so session upkeep gets a separate, larger budget than credential checks.
  const sessionLimiter = limiter("auth-session", 300);
  const sessionPaths = new Set([
    "/refresh",
    "/me",
    "/sessions",
    "/logout",
    "/logout-all",
  ]);
  app.use(`${api}/auth`, (req: Request, res: Response, next: NextFunction) =>
    sessionPaths.has(req.path) || req.path.startsWith("/sessions/")
      ? sessionLimiter(req, res, next)
      : credentialLimiter(req, res, next),
  );
  // Checkout re-quotes as the shopper edits delivery/payment fields.
  app.use(`${api}/checkout`, limiter("checkout", 120));
  const orderCreateLimiter = limiter("order-create", 20);
  app.use(`${api}/orders`, (req: Request, res: Response, next: NextFunction) =>
    req.method === "POST" && req.path === "/"
      ? orderCreateLimiter(req, res, next)
      : next(),
  );
  app.use(`${api}/orders/track`, limiter("order-track", 20));
  app.use(`${api}/orders/confirmation`, limiter("order-confirm", 20));
  app.use(`${api}/payments/bkash/create`, limiter("payment-create", 20));
  app.use(`${api}/payments/bkash/recover`, limiter("payment-recover", 200));
  app.use(`${api}/payments/bkash/callback`, limiter("payment-callback", 100));
  const reviewLimiter = limiter("review", 20);
  app.use(
    `${api}/reviews`,
    (req: Request, res: Response, next: NextFunction) =>
      req.method === "POST" ? reviewLimiter(req, res, next) : next(),
  );
  app.use(
    `${api}/docs`,
    swaggerUi.serve,
    swaggerUi.setup(openapiDocument, { customSiteTitle: "Elite Emporium API" }),
  );
  app.useGlobalFilters(new AppErrorFilter());
  app.enableShutdownHooks();
  await app.init();
  server.use((request: Request, response: Response) => {
    response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `No route matches ${request.method} ${request.originalUrl}.`,
        fieldErrors: null,
        details: null,
      },
      requestId: request.id,
    });
  });
  return app;
}
