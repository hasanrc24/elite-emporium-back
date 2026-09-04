import { timingSafeEqual } from 'node:crypto';
import client from 'prom-client';
import { env } from '../config/env.js';

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'elite_emporium_' });

const requests = new client.Counter({ name: 'elite_emporium_http_requests_total', help: 'HTTP requests by route, method, and status.', labelNames: ['method', 'route', 'status'], registers: [registry] });
const duration = new client.Histogram({ name: 'elite_emporium_http_request_duration_seconds', help: 'HTTP response latency.', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });

function routeLabel(req) { return req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched'; }
export function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    requests.inc(labels); duration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
  });
  next();
}

function tokenMatches(value) {
  if (!env.METRICS_BEARER_TOKEN || !value?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(env.METRICS_BEARER_TOKEN); const actual = Buffer.from(value.slice(7));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function metricsHandler(req, res) {
  if (!tokenMatches(req.get('authorization'))) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' }, requestId: req.id });
  res.setHeader('Content-Type', registry.contentType);
  return res.send(await registry.metrics());
}

export { registry };
