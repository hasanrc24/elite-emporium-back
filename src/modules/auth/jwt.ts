import { readFile } from "node:fs/promises";
import path from "node:path";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { env } from "../../config/env.js";
import { newId } from "../../lib/ids.js";

let privateKeyPromise: ReturnType<typeof importPKCS8> | undefined;
let publicKeyPromise: ReturnType<typeof importSPKI> | undefined;

const getPrivateKey = () =>
  (privateKeyPromise ||= readFile(
    path.resolve(env.JWT_PRIVATE_KEY_PATH),
    "utf8",
  ).then((pem) => importPKCS8(pem, "RS256")));
const getPublicKey = () =>
  (publicKeyPromise ||= readFile(
    path.resolve(env.JWT_PUBLIC_KEY_PATH),
    "utf8",
  ).then((pem) => importSPKI(pem, "RS256")));

export const assertJwtKeys = () =>
  Promise.all([getPrivateKey(), getPublicKey()]);

type TokenType = "access" | "refresh";
interface TokenClaims extends JWTPayload {
  tokenType: TokenType;
  sessionId: string;
  roleVersion?: number;
}

async function signToken(
  subject: string,
  claims: TokenClaims,
  ttlSeconds: number,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: env.JWT_ACTIVE_KID, typ: "JWT" })
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setSubject(subject)
    .setJti(claims.jti || newId())
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + ttlSeconds)
    .sign(await getPrivateKey());
}

export const signAccessToken = (
  user: { id: string; roleVersion: number },
  sessionId: string,
) =>
  signToken(
    user.id,
    { tokenType: "access", sessionId, roleVersion: user.roleVersion },
    env.JWT_ACCESS_TTL_SECONDS,
  );
export const signRefreshToken = (
  user: { id: string },
  sessionId: string,
  jti: string,
  ttlSeconds: number,
) => signToken(user.id, { tokenType: "refresh", sessionId, jti }, ttlSeconds);

async function verify(token: string, type: TokenType): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, await getPublicKey(), {
    algorithms: ["RS256"],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if (
    payload.tokenType !== type ||
    !payload.sub ||
    !payload.jti ||
    !payload.sessionId
  )
    throw new Error("Invalid token type or claims");
  return payload as TokenClaims;
}

export const verifyAccessToken = (token: string) => verify(token, "access");
export const verifyRefreshToken = (token: string) => verify(token, "refresh");
