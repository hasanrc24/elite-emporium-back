import { env } from '../config/env.js';
import { sequelize } from '../db/sequelize.js';
import { pingRedis } from '../lib/redis.js';

const withTimeout = (promise, milliseconds) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Dependency check timed out')), milliseconds)),
]);

export function liveHealth(req, res) {
  res.json({ data: { status: 'ok' }, meta: null, requestId: req.id });
}

export async function readyHealth(req, res) {
  try {
    await withTimeout(sequelize.authenticate(), 2000);
    if (!env.REDIS_OPTIONAL) await withTimeout(pingRedis(), 2000);
    res.json({ data: { status: 'ready' }, meta: null, requestId: req.id });
  } catch {
    res.status(503).json({ error: { code: 'NOT_READY', message: 'A required service is unavailable.', fieldErrors: null, details: null }, requestId: req.id });
  }
}

export function versionInfo(req, res) {
  res.json({ data: { version: env.RELEASE_VERSION, build: env.BUILD_SHA }, meta: null, requestId: req.id });
}
