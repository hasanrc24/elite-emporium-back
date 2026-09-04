import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  keyPrefix: env.REDIS_PREFIX,
});

redis.on('error', (error) => logger.warn({ err: error }, 'Redis connection error'));

export async function pingRedis() {
  if (redis.status === 'wait') await redis.connect();
  return redis.ping();
}

export async function closeRedis() {
  if (['ready', 'connect', 'connecting'].includes(redis.status)) {
    try { await redis.quit(); } catch { redis.disconnect(); }
  }
}
