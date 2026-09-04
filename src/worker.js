import { logger } from './lib/logger.js';
import { env } from './config/env.js';
import { sequelize } from './db/sequelize.js';
import { closeRedis, pingRedis } from './lib/redis.js';
import { runJobsOnce } from './jobs/job-runner.js';
import { ensureMediaDirectories } from './modules/media/media.storage.js';

let stopping = false; let timer;
try {
  await sequelize.authenticate(); await ensureMediaDirectories(); if (!env.REDIS_OPTIONAL) await pingRedis();
  logger.info('Elite Emporium worker ready');
  const tick = async () => {
    if (stopping) return;
    try { const completed = await runJobsOnce(); if (Object.values(completed).some(Boolean)) logger.info({ completed }, 'Background jobs processed'); }
    catch (error) { logger.error({ err: error }, 'Background job batch failed'); }
    timer = setTimeout(tick, 2000); timer.unref();
  };
  await tick();
} catch (error) { logger.fatal({ err: error }, 'Worker startup failed'); process.exitCode = 1; }

const shutdown = async (signal) => { stopping = true; if (timer) clearTimeout(timer); logger.info({ signal }, 'Stopping worker'); await closeRedis(); await sequelize.close(); };
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
