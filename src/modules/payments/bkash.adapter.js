import { env } from '../../config/env.js';
import { IntegrationCredential } from '../../db/models.js';
import { decryptSecret } from '../../lib/encryption.js';
import { AppError } from '../../lib/errors.js';
import { redis, pingRedis } from '../../lib/redis.js';
import { validateOutboundUrl } from '../../lib/safe-url.js';

const memoryTokens = new Map();

export class BkashProviderError extends Error {
  constructor(code, message, { retryable = false, uncertain = false, status = null } = {}) {
    super(message);
    this.name = 'BkashProviderError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.status = status;
  }
}

export function redactBkashPayload(value) {
  if (Array.isArray(value)) return value.map(redactBkashPayload);
  if (!value || typeof value !== 'object') return value;
  const secret = /token|authorization|password|secret|app.?key|credential/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secret.test(key) ? '[REDACTED]' : redactBkashPayload(item)]));
}

function baseUrl() {
  return env.BKASH_MODE === 'live' ? env.BKASH_LIVE_BASE_URL : env.BKASH_SANDBOX_BASE_URL;
}

async function credentials() {
  const row = await IntegrationCredential.findOne({ where: { provider: 'bkash', environment: env.BKASH_MODE, active: true } });
  if (!row || row.testStatus !== 'success') throw AppError.unprocessable('BKASH_NOT_CONFIGURED', 'bKash is not configured and tested.');
  const value = decryptSecret(row.encryptedPayload);
  for (const key of ['username', 'password', 'appKey', 'appSecret']) if (!value[key] || typeof value[key] !== 'string') throw AppError.unprocessable('BKASH_NOT_CONFIGURED', 'bKash credentials are incomplete.');
  return value;
}

async function endpoint(relativePath) {
  const base = `${baseUrl().replace(/\/$/, '')}/`;
  const url = new URL(relativePath.replace(/^\//, ''), base).toString();
  await validateOutboundUrl(url);
  return url;
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(env.BKASH_HTTP_TIMEOUT_MS), headers: { accept: 'application/json', 'content-type': 'application/json', ...options.headers } });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new BkashProviderError(timeout ? 'BKASH_TIMEOUT' : 'BKASH_NETWORK_ERROR', 'The bKash service could not be reached.', { retryable: true, uncertain: options.method !== 'GET' });
  }
  let body;
  try { body = await response.json(); } catch { throw new BkashProviderError('BKASH_INVALID_RESPONSE', 'bKash returned an invalid response.', { retryable: response.status >= 500, uncertain: options.method !== 'GET', status: response.status }); }
  if (!response.ok) throw new BkashProviderError(`BKASH_HTTP_${response.status}`, body.statusMessage || body.message || 'bKash rejected the request.', { retryable: response.status >= 500 || response.status === 429, uncertain: false, status: response.status });
  return body;
}

async function readCachedToken(cacheKey) {
  const memory = memoryTokens.get(cacheKey);
  if (memory?.expiresAt > Date.now()) return memory.token;
  try {
    await pingRedis();
    const cached = await redis.get(cacheKey);
    return cached || null;
  } catch { return null; }
}

async function cacheToken(cacheKey, token, seconds) {
  const ttl = Math.max(30, seconds - 60);
  memoryTokens.set(cacheKey, { token, expiresAt: Date.now() + ttl * 1000 });
  try { await redis.set(cacheKey, token, 'EX', ttl); } catch { /* Redis is optional outside production. */ }
}

async function authorizationToken(force = false) {
  const cacheKey = `bkash:authorization:${env.BKASH_MODE}`;
  if (!force) {
    const cached = await readCachedToken(cacheKey);
    if (cached) return cached;
  }
  const config = await credentials();
  const body = await requestJson(await endpoint('checkout/token/grant'), { method: 'POST', headers: { username: config.username, password: config.password }, body: JSON.stringify({ app_key: config.appKey, app_secret: config.appSecret }) });
  if (!body.id_token) throw new BkashProviderError(body.statusCode || 'BKASH_TOKEN_REJECTED', body.statusMessage || 'bKash authorization failed.');
  await cacheToken(cacheKey, body.id_token, Number(body.expires_in) || 3600);
  return body.id_token;
}

async function authorizedRequest(relativePath, options = {}, retryAuthorization = true) {
  const config = await credentials();
  const token = await authorizationToken();
  try {
    return await requestJson(await endpoint(relativePath), { ...options, headers: { authorization: token, 'x-app-key': config.appKey, ...options.headers } });
  } catch (error) {
    if (retryAuthorization && error instanceof BkashProviderError && error.status === 401) {
      const nextToken = await authorizationToken(true);
      return requestJson(await endpoint(relativePath), { ...options, headers: { authorization: nextToken, 'x-app-key': config.appKey, ...options.headers } });
    }
    throw error;
  }
}

function assertSuccess(body, operation) {
  if (body.statusCode && body.statusCode !== '0000') throw new BkashProviderError(`BKASH_${body.statusCode}`, body.statusMessage || `bKash ${operation} failed.`, { retryable: false });
  return body;
}

export async function createBkashPayment({ amount, invoice, locale = 'en' }) {
  const callbackURL = `${env.BKASH_CALLBACK_ORIGIN.replace(/\/$/, '')}/${locale}/payment/bkash`;
  const body = assertSuccess(await authorizedRequest('checkout/payment/create', { method: 'POST', body: JSON.stringify({ amount, currency: 'BDT', intent: 'sale', merchantInvoiceNumber: invoice, callbackURL }) }), 'payment creation');
  if (!body.paymentID || !body.bkashURL) throw new BkashProviderError('BKASH_CREATE_INCOMPLETE', 'bKash did not return a payment ID and redirect URL.');
  return body;
}

export async function executeBkashPayment(paymentId) {
  return assertSuccess(await authorizedRequest(`checkout/payment/execute/${encodeURIComponent(paymentId)}`, { method: 'POST', body: '{}' }), 'payment execution');
}

export async function queryBkashPayment(paymentId) {
  return assertSuccess(await authorizedRequest(`checkout/payment/query/${encodeURIComponent(paymentId)}`, { method: 'GET' }), 'payment query');
}

export async function refundBkashPayment({ paymentId, transactionId, amount, sku, reason }) {
  return assertSuccess(await authorizedRequest('checkout/payment/refund', {
    method: 'POST',
    body: JSON.stringify({
      paymentID: paymentId,
      trxID: transactionId,
      amount,
      sku: sku || 'ORDER',
      reason,
    }),
  }), 'payment refund');
}

export async function queryBkashRefund({ paymentId, transactionId }) {
  return assertSuccess(await authorizedRequest('checkout/payment/refund/status', {
    method: 'POST',
    body: JSON.stringify({ paymentID: paymentId, trxID: transactionId }),
  }), 'refund status query');
}

export async function testBkashConnection(candidate) {
  const url = await endpoint('checkout/token/grant');
  const body = await requestJson(url, { method: 'POST', headers: { username: candidate.username, password: candidate.password }, body: JSON.stringify({ app_key: candidate.appKey, app_secret: candidate.appSecret }) });
  if (!body.id_token) throw new BkashProviderError(body.statusCode || 'BKASH_TOKEN_REJECTED', body.statusMessage || 'bKash authorization failed.');
  return { ok: true, mode: env.BKASH_MODE };
}
