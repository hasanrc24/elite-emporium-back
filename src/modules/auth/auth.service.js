import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import QRCode from 'qrcode';
import { Op } from 'sequelize';
import {
  AuthChallenge,
  AuthSession,
  MfaMethod,
  MfaRecoveryCode,
  PasswordResetToken,
  Role,
  Order,
  OrderEvent,
  User,
  VerificationToken,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { sha256 } from '../../lib/crypto.js';
import { decryptSecret, encryptSecret } from '../../lib/encryption.js';
import { normalizeEmail, normalizeIdentifier, normalizePhone } from '../../lib/normalization.js';
import { recordAudit } from '../audits/audit.service.js';
import { queueNotification } from '../events/outbox.service.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './jwt.js';
import { effectivePermissionKeys, userAuthInclude } from './authorization.js';

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: env.ARGON2_MEMORY_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
};
export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    locale: user.locale,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    emailVerified: Boolean(user.emailVerifiedAt),
    mustChangePassword: Boolean(user.mustChangePassword),
    mfaEnabled: Boolean(user.mfaMethods?.length),
    roles: user.roles?.map((role) => role.key) || [],
    permissions: effectivePermissionKeys(user),
    version: user.version,
  };
}

export const resolvePermissions = (user) => new Set(effectivePermissionKeys(user));

async function loadUser(id, transaction) {
  return User.findByPk(id, { include: userAuthInclude, transaction });
}

async function claimGuestOrders(user, transaction, reference = null) {
  const identifiers = [];
  if (user.phone && (reference || user.phoneVerifiedAt)) identifiers.push({ customerPhone: user.phone });
  if (user.email && !reference && user.emailVerifiedAt) identifiers.push({ customerEmail: user.email });
  if (!identifiers.length) return 0;
  const where = { userId: null, [Op.or]: identifiers, ...(reference ? { reference } : {}) };
  const rows = await Order.findAll({ where, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  if (!rows.length) return 0;
  await Order.update({ userId: user.id }, { where: { id: { [Op.in]: rows.map((row) => row.id) }, userId: null }, transaction });
  await OrderEvent.bulkCreate(rows.map((row) => ({ id: newId(), orderId: row.id, type: 'customer_claimed', message: 'Order linked to customer account.', public: true, actorId: user.id, metadata: { source: reference ? 'registration_reference' : 'verified_login_identifier' } })), { transaction });
  return rows.length;
}

function ipPrefix(value) {
  const ip = String(value || '').replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  return ip.slice(0, 64) || null;
}

export async function hashPassword(password) {
  return argon2.hash(password, passwordOptions);
}

async function createTokenPair(user, rememberMe, context, transaction) {
  const ttl = rememberMe ? env.JWT_REFRESH_REMEMBER_TTL_SECONDS : env.JWT_REFRESH_TTL_SECONDS;
  const sessionId = newId();
  const jti = newId();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await AuthSession.create({
    id: sessionId,
    userId: user.id,
    familyId: newId(),
    currentJtiHash: sha256(jti),
    expiresAt,
    lastUsedAt: new Date(),
    userAgent: context.userAgent?.slice(0, 255) || null,
    ipAddress: ipPrefix(context.ip),
  }, { transaction });
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(user, sessionId),
    signRefreshToken(user, sessionId, jti, ttl),
  ]);
  return { accessToken, refreshToken, accessExpiresIn: env.JWT_ACCESS_TTL_SECONDS, refreshExpiresAt: expiresAt };
}

export async function queueVerification(user, channel, transaction) {
  const target = channel === 'phone' ? user.phone : user.email;
  if (!target) throw AppError.unprocessable('VERIFICATION_TARGET_MISSING', `Add a ${channel} before requesting verification.`);
  const latest = await VerificationToken.findOne({
    where: { userId: user.id, channel, purpose: 'verify', consumedAt: null },
    order: [['sentAt', 'DESC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (latest?.sentAt && Date.now() - latest.sentAt.getTime() < env.VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000) {
    throw AppError.tooManyRequests('VERIFICATION_COOLDOWN', 'Please wait before requesting another verification code.');
  }
  await VerificationToken.update({ consumedAt: new Date() }, { where: { userId: user.id, channel, purpose: 'verify', consumedAt: null }, transaction });
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + env.VERIFICATION_CODE_TTL_SECONDS * 1000);
  const token = await VerificationToken.create({
    id: newId(), userId: user.id, channel, purpose: 'verify', target,
    tokenHash: sha256(code), expiresAt, attempts: 0, sentAt: new Date(),
  }, { transaction });
  await queueNotification({
    event: 'account.verify',
    channel: channel === 'phone' ? 'sms' : 'email',
    locale: user.locale,
    recipient: target,
    payload: { secure: encryptSecret({ code }), expiresAt: expiresAt.toISOString(), name: user.name },
    transaction,
  });
  return token;
}

export async function register(payload, context) {
  const phone = normalizePhone(payload.phone);
  const email = normalizeEmail(payload.email);
  if (!phone && !email) throw AppError.unprocessable('IDENTIFIER_REQUIRED', 'A valid phone number or email is required.');
  if (payload.phone && !phone) throw AppError.unprocessable('INVALID_PHONE', 'Enter a valid Bangladeshi phone number.', { phone: ['Enter a valid Bangladeshi phone number.'] });
  return sequelize.transaction(async (transaction) => {
    const duplicate = await User.findOne({ where: { [Op.or]: [phone && { phone }, email && { email }].filter(Boolean) }, paranoid: false, transaction });
    if (duplicate) throw AppError.conflict('ACCOUNT_EXISTS', 'An account already exists for this phone number or email.');
    const customerRole = await Role.findOne({ where: { key: 'customer', active: true }, transaction });
    if (!customerRole) throw new Error('Customer role has not been seeded');
    const user = await User.create({ id: newId(), name: payload.name.trim(), phone, email, passwordHash: await hashPassword(payload.password), locale: payload.locale || 'en' }, { transaction });
    await user.addRole(customerRole, { transaction });
    const hydrated = await loadUser(user.id, transaction);
    if (payload.orderReference) await claimGuestOrders(hydrated, transaction, payload.orderReference);
    if (phone) await queueVerification(hydrated, 'phone', transaction);
    if (email) await queueVerification(hydrated, 'email', transaction);
    const tokens = await createTokenPair(hydrated, payload.rememberMe, context, transaction);
    return { user: publicUser(hydrated), ...tokens };
  });
}

export async function login(payload, context) {
  let identifier;
  try { identifier = normalizeIdentifier(payload.identifier); } catch { throw AppError.unauthorized('INVALID_CREDENTIALS', 'Phone/email or password is incorrect.'); }
  const user = await User.findOne({ where: { ...identifier, status: 'active' }, include: userAuthInclude });
  if (!user || !(await argon2.verify(user.passwordHash, payload.password))) throw AppError.unauthorized('INVALID_CREDENTIALS', 'Phone/email or password is incorrect.');
  user.lastLoginAt = new Date();
  await user.save();
  if (user.mfaMethods?.length) {
    const challengeToken = randomBytes(32).toString('base64url');
    const challengeExpiresAt = new Date(Date.now() + env.MFA_CHALLENGE_TTL_SECONDS * 1000);
    await AuthChallenge.create({
      id: newId(), userId: user.id, type: 'mfa_login', tokenHash: sha256(challengeToken),
      rememberMe: payload.rememberMe, expiresAt: challengeExpiresAt,
      userAgent: context.userAgent?.slice(0, 255) || null, ipAddress: ipPrefix(context.ip),
    });
    return { mfaRequired: true, challengeToken, challengeExpiresAt, methods: ['totp', 'recovery_code'] };
  }
  return sequelize.transaction(async (transaction) => {
    await claimGuestOrders(user, transaction);
    const tokens = await createTokenPair(user, payload.rememberMe, context, transaction);
    return { user: publicUser(user), ...tokens };
  });
}

async function verifyMfaCode(method, code, transaction) {
  const normalized = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d{6}$/.test(normalized)) {
    const result = await verifyOtp({ secret: decryptSecret(method.encryptedSecret), token: normalized, epochTolerance: 30 });
    return result.valid;
  }
  const recovery = await MfaRecoveryCode.findOne({ where: { methodId: method.id, codeHash: sha256(normalized), consumedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
  if (!recovery) return false;
  recovery.consumedAt = new Date();
  await recovery.save({ transaction });
  return true;
}

export async function verifyMfaLogin(payload, context) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const challenge = await AuthChallenge.findOne({ where: { tokenHash: sha256(payload.challengeToken) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) return { error: 'MFA_CHALLENGE_EXPIRED' };
    if (challenge.attempts >= env.VERIFICATION_MAX_ATTEMPTS) return { error: 'MFA_ATTEMPTS_EXCEEDED' };
    const method = await MfaMethod.findOne({ where: { userId: challenge.userId, type: 'totp', confirmedAt: { [Op.ne]: null }, disabledAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!method || !(await verifyMfaCode(method, payload.code, transaction))) {
      challenge.attempts += 1;
      await challenge.save({ transaction });
      return { error: challenge.attempts >= env.VERIFICATION_MAX_ATTEMPTS ? 'MFA_ATTEMPTS_EXCEEDED' : 'INVALID_MFA_CODE' };
    }
    challenge.consumedAt = new Date();
    await challenge.save({ transaction });
    const user = await loadUser(challenge.userId, transaction);
    if (!user || user.status !== 'active') return { error: 'ACCOUNT_UNAVAILABLE' };
    await claimGuestOrders(user, transaction);
    const tokens = await createTokenPair(user, challenge.rememberMe, context, transaction);
    return { user: publicUser(user), ...tokens };
  });
  if ('error' in outcome) throw AppError.unauthorized(outcome.error, outcome.error === 'INVALID_MFA_CODE' ? 'The authentication code is incorrect.' : 'The MFA challenge is no longer valid. Sign in again.');
  return outcome;
}

export async function refresh(refreshToken, context) {
  let claims;
  try { claims = await verifyRefreshToken(refreshToken); } catch { throw AppError.unauthorized('INVALID_REFRESH_TOKEN', 'Your session has expired.'); }
  const outcome = await sequelize.transaction(async (transaction) => {
    const session = await AuthSession.findOne({ where: { id: claims.sessionId, userId: claims.sub }, transaction, lock: transaction.LOCK.UPDATE });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return { error: 'SESSION_EXPIRED' };
    if (session.currentJtiHash !== sha256(String(claims.jti))) {
      session.revokedAt = new Date();
      session.revokeReason = 'refresh_token_reuse';
      await session.save({ transaction });
      await recordAudit({ actorId: session.userId, action: 'auth.refresh_reuse', resourceType: 'auth_session', resourceId: session.id, metadata: { familyId: session.familyId }, transaction });
      return { error: 'REFRESH_TOKEN_REUSE' };
    }
    const user = await loadUser(String(claims.sub), transaction);
    if (!user || user.status !== 'active') return { error: 'ACCOUNT_UNAVAILABLE' };
    const ttl = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    const newJti = newId();
    session.currentJtiHash = sha256(newJti);
    session.lastUsedAt = new Date();
    session.userAgent = context.userAgent?.slice(0, 255) || null;
    session.ipAddress = ipPrefix(context.ip);
    await session.save({ transaction });
    const [accessToken, nextRefreshToken] = await Promise.all([signAccessToken(user, session.id), signRefreshToken(user, session.id, newJti, ttl)]);
    return { user: publicUser(user), accessToken, refreshToken: nextRefreshToken, accessExpiresIn: env.JWT_ACCESS_TTL_SECONDS, refreshExpiresAt: session.expiresAt };
  });
  if ('error' in outcome) {
    const message = outcome.error === 'REFRESH_TOKEN_REUSE' ? 'This session was revoked for security. Sign in again.' : 'Your session has expired.';
    throw AppError.unauthorized(outcome.error, message);
  }
  return outcome;
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  try {
    const claims = await verifyRefreshToken(refreshToken);
    await AuthSession.update({ revokedAt: new Date(), revokeReason: 'logout' }, { where: { id: claims.sessionId, userId: claims.sub, revokedAt: null } });
  } catch { /* The cookie is cleared regardless. */ }
}

export async function logoutAll(userId) {
  await AuthSession.update({ revokedAt: new Date(), revokeReason: 'logout_all' }, { where: { userId, revokedAt: null } });
}

export async function listSessions(userId, currentSessionId) {
  const sessions = await AuthSession.findAll({ where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } }, order: [['lastUsedAt', 'DESC']] });
  return sessions.map((session) => ({ id: session.id, current: session.id === currentSessionId, userAgent: session.userAgent, ipPrefix: session.ipAddress, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt }));
}

export async function revokeSession(userId, sessionId) {
  const [count] = await AuthSession.update({ revokedAt: new Date(), revokeReason: 'remote_revoke' }, { where: { id: sessionId, userId, revokedAt: null } });
  if (!count) throw AppError.notFound('Active session not found.');
}

export async function forgotPassword(identifierValue, context) {
  let identifier;
  try { identifier = normalizeIdentifier(identifierValue); } catch { return; }
  const user = await User.findOne({ where: { ...identifier, status: 'active' } });
  if (!user) return;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000);
  await sequelize.transaction(async (transaction) => {
    await PasswordResetToken.update({ consumedAt: new Date() }, { where: { userId: user.id, consumedAt: null }, transaction });
    await PasswordResetToken.create({ id: newId(), userId: user.id, tokenHash: sha256(token), expiresAt, requestedIp: ipPrefix(context.ip), requestedUserAgent: context.userAgent?.slice(0, 255) || null }, { transaction });
    const channel = identifier.phone ? 'sms' : 'email';
    await queueNotification({ event: 'account.password_reset', channel, locale: user.locale, recipient: identifier.phone || identifier.email, payload: { secure: encryptSecret({ token }), expiresAt: expiresAt.toISOString(), name: user.name }, transaction });
  });
}

export async function resetPassword(payload) {
  const outcome = await sequelize.transaction(async (transaction) => {
    const reset = await PasswordResetToken.findOne({ where: { tokenHash: sha256(payload.token) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!reset || reset.consumedAt || reset.expiresAt <= new Date()) return false;
    const user = await User.findByPk(reset.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || user.status !== 'active') return false;
    user.passwordHash = await hashPassword(payload.password);
    user.mustChangePassword = false;
    user.version += 1;
    await user.save({ transaction });
    reset.consumedAt = new Date();
    await reset.save({ transaction });
    await PasswordResetToken.update({ consumedAt: new Date() }, { where: { userId: user.id, id: { [Op.ne]: reset.id }, consumedAt: null }, transaction });
    await AuthSession.update({ revokedAt: new Date(), revokeReason: 'password_reset' }, { where: { userId: user.id, revokedAt: null }, transaction });
    await recordAudit({ actorId: user.id, action: 'auth.password_reset', resourceType: 'user', resourceId: user.id, transaction });
    return true;
  });
  if (!outcome) throw AppError.unprocessable('INVALID_RESET_TOKEN', 'This password reset link is invalid or expired.');
}

export async function changePassword(userId, currentSessionId, payload, request) {
  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !(await argon2.verify(user.passwordHash, payload.currentPassword))) throw AppError.unprocessable('CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect.', { currentPassword: ['The current password is incorrect.'] });
    user.passwordHash = await hashPassword(payload.password);
    user.mustChangePassword = false;
    user.version += 1;
    await user.save({ transaction });
    await AuthSession.update({ revokedAt: new Date(), revokeReason: 'password_changed' }, { where: { userId, id: { [Op.ne]: currentSessionId }, revokedAt: null }, transaction });
    await recordAudit({ actorId: userId, action: 'auth.password_change', resourceType: 'user', resourceId: userId, request, transaction });
  });
}

export async function resendVerification(userId, channel) {
  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw AppError.notFound('User not found.');
    if ((channel === 'phone' && user.phoneVerifiedAt) || (channel === 'email' && user.emailVerifiedAt)) throw AppError.conflict('ALREADY_VERIFIED', `Your ${channel} is already verified.`);
    await queueVerification(user, channel, transaction);
  });
}

export async function verifyIdentity(userId, channel, code, request) {
  const result = await sequelize.transaction(async (transaction) => {
    const token = await VerificationToken.findOne({ where: { userId, channel, purpose: 'verify', consumedAt: null }, order: [['sentAt', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!token || token.expiresAt <= new Date()) return 'expired';
    if (token.attempts >= env.VERIFICATION_MAX_ATTEMPTS) return 'attempts';
    if (token.tokenHash !== sha256(code)) {
      token.attempts += 1;
      await token.save({ transaction });
      return token.attempts >= env.VERIFICATION_MAX_ATTEMPTS ? 'attempts' : 'invalid';
    }
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || token.target !== user[channel]) return 'expired';
    token.consumedAt = new Date();
    await token.save({ transaction });
    user[`${channel}VerifiedAt`] = new Date();
    user.version += 1;
    await user.save({ transaction });
    await claimGuestOrders(user, transaction);
    await recordAudit({ actorId: userId, action: `auth.${channel}_verified`, resourceType: 'user', resourceId: userId, request, transaction });
    return 'ok';
  });
  if (result !== 'ok') throw AppError.unprocessable(result === 'invalid' ? 'INVALID_VERIFICATION_CODE' : 'VERIFICATION_CODE_EXPIRED', result === 'invalid' ? 'The verification code is incorrect.' : 'The verification code is expired or no longer valid.');
}

export async function setupMfa(user, label) {
  const active = await MfaMethod.findOne({ where: { userId: user.id, confirmedAt: { [Op.ne]: null }, disabledAt: null } });
  if (active) throw AppError.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled.');
  const secret = generateSecret();
  const uri = generateURI({ issuer: env.STORE_NAME, label: label || user.email || user.phone || user.id, secret });
  const method = await sequelize.transaction(async (transaction) => {
    await MfaMethod.destroy({ where: { userId: user.id, confirmedAt: null }, transaction });
    return MfaMethod.create({ id: newId(), userId: user.id, type: 'totp', encryptedSecret: encryptSecret(secret), label: label || null }, { transaction });
  });
  return { enrollmentId: method.id, secret, uri, qrCodeDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 }) };
}

function recoveryCode() {
  return randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

export async function confirmMfa(userId, payload, request) {
  const result = await sequelize.transaction(async (transaction) => {
    const method = await MfaMethod.findOne({ where: { id: payload.enrollmentId, userId, confirmedAt: null, disabledAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!method) return null;
    const verification = await verifyOtp({ secret: decryptSecret(method.encryptedSecret), token: payload.code, epochTolerance: 30 });
    if (!verification.valid) return null;
    const codes = Array.from({ length: 10 }, recoveryCode);
    method.confirmedAt = new Date();
    await method.save({ transaction });
    await MfaRecoveryCode.bulkCreate(codes.map((code) => ({ id: newId(), methodId: method.id, codeHash: sha256(code.replaceAll('-', '')) })), { transaction });
    await recordAudit({ actorId: userId, action: 'auth.mfa_enabled', resourceType: 'user', resourceId: userId, request, transaction });
    return codes;
  });
  if (!result) throw AppError.unprocessable('INVALID_MFA_CODE', 'The authentication code is incorrect.');
  return { recoveryCodes: result };
}

export async function disableMfa(user, currentSessionId, payload, request) {
  if (!(await argon2.verify(user.passwordHash, payload.password))) throw AppError.unprocessable('PASSWORD_INCORRECT', 'The password is incorrect.', { password: ['The password is incorrect.'] });
  const disabled = await sequelize.transaction(async (transaction) => {
    const method = await MfaMethod.findOne({ where: { userId: user.id, confirmedAt: { [Op.ne]: null }, disabledAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!method || !(await verifyMfaCode(method, payload.code, transaction))) return false;
    method.disabledAt = new Date();
    await method.save({ transaction });
    await MfaRecoveryCode.update({ consumedAt: new Date() }, { where: { methodId: method.id, consumedAt: null }, transaction });
    await AuthSession.update({ revokedAt: new Date(), revokeReason: 'mfa_disabled' }, { where: { userId: user.id, id: { [Op.ne]: currentSessionId }, revokedAt: null }, transaction });
    await recordAudit({ actorId: user.id, action: 'auth.mfa_disabled', resourceType: 'user', resourceId: user.id, request, transaction });
    return true;
  });
  if (!disabled) throw AppError.unprocessable('INVALID_MFA_CODE', 'The authentication code or recovery code is incorrect.');
}
