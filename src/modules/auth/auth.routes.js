import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../app/middleware/validate.js';
import { authenticate } from '../../app/middleware/authenticate.js';
import { originGuard } from '../../app/middleware/origin-guard.js';
import * as auth from './auth.service.js';

export const authRouter = Router();
const password = z.string().min(8).max(128).regex(/[A-Za-z]/, 'Include at least one letter.').regex(/\d/, 'Include at least one number.');
const identifier = z.string().trim().min(3).max(190);
const code = z.string().trim().min(6).max(40);
const registerSchema = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().optional().default(''), email: z.string().optional().default(''), password, locale: z.enum(['en', 'bn']).default('en'), rememberMe: z.boolean().default(true), orderReference: z.string().trim().min(6).max(40).optional() });
const loginSchema = z.object({ identifier, password: z.string().min(1).max(128), rememberMe: z.boolean().default(true) });
const context = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });
const cookieOptions = (expires) => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE, path: `${env.API_BASE_PATH}/auth`, expires });

function sendTokens(req, res, result, status = 200) {
  if (result.mfaRequired) return res.status(status).json({ data: result, meta: null, requestId: req.id });
  res.cookie(env.REFRESH_COOKIE_NAME, result.refreshToken, cookieOptions(result.refreshExpiresAt));
  return res.status(status).json({ data: { accessToken: result.accessToken, accessExpiresIn: result.accessExpiresIn, user: result.user }, meta: null, requestId: req.id });
}

authRouter.post('/register', validate(registerSchema), async (req, res) => sendTokens(req, res, await auth.register(req.body, context(req)), 201));
authRouter.post('/login', validate(loginSchema), async (req, res) => sendTokens(req, res, await auth.login(req.body, context(req))));
authRouter.post('/mfa/verify', validate(z.object({ challengeToken: z.string().min(32).max(200), code })), async (req, res) => sendTokens(req, res, await auth.verifyMfaLogin(req.body, context(req))));
authRouter.post('/refresh', originGuard, async (req, res) => {
  try {
    return sendTokens(req, res, await auth.refresh(req.cookies[env.REFRESH_COOKIE_NAME], context(req)));
  } catch (error) {
    res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
    throw error;
  }
});
authRouter.post('/logout', originGuard, async (req, res) => {
  await auth.logout(req.cookies[env.REFRESH_COOKIE_NAME]);
  res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
  res.status(204).end();
});
authRouter.post('/logout-all', authenticate, async (req, res) => {
  await auth.logoutAll(req.auth.user.id);
  res.clearCookie(env.REFRESH_COOKIE_NAME, cookieOptions(new Date(0)));
  res.status(204).end();
});
authRouter.get('/me', authenticate, async (req, res) => res.json({ data: auth.publicUser(req.auth.user), meta: null, requestId: req.id }));
authRouter.get('/sessions', authenticate, async (req, res) => res.json({ data: await auth.listSessions(req.auth.user.id, req.auth.session.id), meta: null, requestId: req.id }));
authRouter.delete('/sessions/:id', authenticate, async (req, res) => { await auth.revokeSession(req.auth.user.id, req.params.id); res.status(204).end(); });

authRouter.post('/forgot-password', validate(z.object({ identifier })), async (req, res) => {
  await auth.forgotPassword(req.body.identifier, context(req));
  res.status(202).json({ data: { accepted: true }, meta: null, requestId: req.id });
});
authRouter.post('/reset-password', validate(z.object({ token: z.string().min(32).max(200), password })), async (req, res) => {
  await auth.resetPassword(req.body);
  res.status(204).end();
});
authRouter.post('/change-password', authenticate, validate(z.object({ currentPassword: z.string().min(1).max(128), password })), async (req, res) => {
  await auth.changePassword(req.auth.user.id, req.auth.session.id, req.body, req);
  res.status(204).end();
});

authRouter.post('/verify/resend', authenticate, validate(z.object({ channel: z.enum(['phone', 'email']) })), async (req, res) => {
  await auth.resendVerification(req.auth.user.id, req.body.channel);
  res.status(202).json({ data: { accepted: true }, meta: null, requestId: req.id });
});
for (const channel of ['phone', 'email']) {
  authRouter.post(`/verify/${channel}`, authenticate, validate(z.object({ code: z.string().regex(/^\d{6}$/) })), async (req, res) => {
    await auth.verifyIdentity(req.auth.user.id, channel, req.body.code, req);
    res.status(204).end();
  });
}

authRouter.post('/mfa/setup', authenticate, validate(z.object({ label: z.string().trim().max(120).optional() })), async (req, res) => res.json({ data: await auth.setupMfa(req.auth.user, req.body.label), meta: null, requestId: req.id }));
authRouter.post('/mfa/confirm', authenticate, validate(z.object({ enrollmentId: z.string().length(26), code: z.string().regex(/^\d{6}$/) })), async (req, res) => res.json({ data: await auth.confirmMfa(req.auth.user.id, req.body, req), meta: null, requestId: req.id }));
authRouter.delete('/mfa', authenticate, validate(z.object({ password: z.string().min(1).max(128), code })), async (req, res) => {
  await auth.disableMfa(req.auth.user, req.auth.session.id, req.body, req);
  res.status(204).end();
});
