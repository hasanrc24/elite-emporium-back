import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.currentPassword",
      "req.body.code",
      "req.body.token",
      "req.body.appSecret",
      "req.body.secret",
      "password",
      "*.password",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.otp",
      "*.privateKey",
      "*.encryptedPayload",
      "*.payload.secure",
    ],
    censor: "[REDACTED]",
  },
});
