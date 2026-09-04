import { createServer } from 'node:http';
import { createApp } from './app/create-app.js';
import { env } from './config/env.js';
import { sequelize } from './db/sequelize.js';
import { logger } from './lib/logger.js';
import { closeRedis, pingRedis } from './lib/redis.js';
import { assertJwtKeys } from './modules/auth/jwt.js';
import { ensureMediaDirectories } from './modules/media/media.storage.js';

let server;
try {
  await sequelize.authenticate();
  await assertJwtKeys();
  await ensureMediaDirectories();
  if (!env.REDIS_OPTIONAL) await pingRedis();
  server = createServer(createApp());
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Elite Emporium API listening'));
} catch (error) {
  logger.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 10000).unref();
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeRedis();
  await sequelize.close();
  clearTimeout(force);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
