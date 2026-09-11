import { createNestApplication } from "./app/bootstrap.js";
import { env } from "./config/env.js";
import { sequelize } from "./db/sequelize.js";
import { logger } from "./lib/logger.js";
import { closeRedis, pingRedis } from "./lib/redis.js";
import { assertJwtKeys } from "./modules/auth/jwt.js";
import { ensureMediaDirectories } from "./modules/media/media.storage.js";

let app: Awaited<ReturnType<typeof createNestApplication>> | undefined;
try {
  await sequelize.authenticate();
  await assertJwtKeys();
  await ensureMediaDirectories();
  if (!env.REDIS_OPTIONAL) await pingRedis();
  app = await createNestApplication();
  await app.listen(env.PORT, "0.0.0.0");
  logger.info({ port: env.PORT }, "Elite Emporium NestJS API listening");
} catch (error) {
  logger.fatal({ err: error }, "API startup failed");
  if (app) await app.close().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  await sequelize.close().catch(() => undefined);
  process.exitCode = 1;
}
