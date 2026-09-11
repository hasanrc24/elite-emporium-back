import { Op } from "sequelize";
import { AuthSession, User } from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { verifyAccessToken } from "../../modules/auth/jwt.js";
import {
  effectivePermissionKeys,
  userAuthInclude,
} from "../../modules/auth/authorization.js";
import type { Request } from "express";

export async function authenticateRequest(req: Request): Promise<void> {
  const authorization = req.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw AppError.unauthorized();
  try {
    const claims = await verifyAccessToken(authorization.slice(7));
    const [user, session] = await Promise.all([
      User.findOne({
        where: { id: claims.sub, status: "active" },
        include: userAuthInclude,
      }),
      AuthSession.findOne({
        where: {
          id: claims.sessionId,
          userId: claims.sub,
          revokedAt: null,
          expiresAt: { [Op.gt]: new Date() },
        },
      }),
    ]);
    if (!user || !session || user.roleVersion !== claims.roleVersion)
      throw AppError.unauthorized(
        "SESSION_INVALID",
        "Your session is no longer valid.",
      );
    req.auth = {
      user,
      session,
      permissions: new Set(effectivePermissionKeys(user)),
      claims,
    };
  } catch (error) {
    throw error instanceof AppError
      ? error
      : AppError.unauthorized(
          "INVALID_ACCESS_TOKEN",
          "Your access token is invalid or expired.",
        );
  }
}

export function requireRequestPermission(
  request: Request,
  permission: string,
): void {
  if (!request.auth?.permissions.has(permission)) throw AppError.forbidden();
}
