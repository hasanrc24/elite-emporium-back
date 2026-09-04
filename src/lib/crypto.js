import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', env.COOKIE_SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyPayload(token) {
  try {
    const [body, signature] = String(token).split('.');
    const expected = createHmac('sha256', env.COOKIE_SIGNING_SECRET).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
