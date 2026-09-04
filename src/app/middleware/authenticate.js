import { Op } from 'sequelize';
import { AuthSession, User } from '../../db/models.js';
import { AppError } from '../../lib/errors.js';
import { verifyAccessToken } from '../../modules/auth/jwt.js';
import { effectivePermissionKeys, userAuthInclude } from '../../modules/auth/authorization.js';

export async function authenticate(req, _res, next) {
  try {
    const authorization = req.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) throw AppError.unauthorized();
    const claims = await verifyAccessToken(authorization.slice(7));
    const [user, session] = await Promise.all([
      User.findOne({ where: { id: claims.sub, status: 'active' }, include: userAuthInclude }),
      AuthSession.findOne({ where: { id: claims.sessionId, userId: claims.sub, revokedAt: null, expiresAt: { [Op.gt]: new Date() } } }),
    ]);
    if (!user || !session || user.roleVersion !== claims.roleVersion) throw AppError.unauthorized('SESSION_INVALID', 'Your session is no longer valid.');
    const permissions = new Set(effectivePermissionKeys(user));
    req.auth = { user, session, permissions, claims };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : AppError.unauthorized('INVALID_ACCESS_TOKEN', 'Your access token is invalid or expired.'));
  }
}

export async function optionalAuthenticate(req, res, next) {
  if (!(req.get('authorization') || '').startsWith('Bearer ')) return next();
  return authenticate(req, res, next);
}

export const requirePermission = (permission) => (req, _res, next) => {
  if (!req.auth?.permissions.has(permission)) return next(AppError.forbidden());
  next();
};
