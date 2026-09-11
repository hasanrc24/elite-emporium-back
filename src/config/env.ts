import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const booleanValue = z
  .string()
  .default("false")
  .transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    API_BASE_PATH: z
      .string()
      .regex(/^\/[a-z0-9/-]+$/)
      .default("/api/v1"),
    PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
    TRUST_PROXY: booleanValue,
    LOG_LEVEL: z.string().default("info"),
    DB_HOST: z.string().default("127.0.0.1"),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_NAME: z.string().default("elite_emporium"),
    DB_USER: z.string().default("elite_emporium"),
    DB_PASSWORD: z.string().default("elite-emporium-local"),
    DB_POOL_MIN: z.coerce.number().int().min(0).default(0),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_POOL_ACQUIRE_MS: z.coerce.number().int().positive().default(30000),
    DB_POOL_IDLE_MS: z.coerce.number().int().positive().default(10000),
    DB_SSL: booleanValue,
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    REDIS_PREFIX: z.string().default("ee:"),
    REDIS_OPTIONAL: z
      .string()
      .default("true")
      .transform((value) => value === "true"),
    JWT_ISSUER: z.string().default("elite-emporium-api"),
    JWT_AUDIENCE: z.string().default("elite-emporium-web"),
    JWT_ACTIVE_KID: z.string().default("local-1"),
    JWT_PRIVATE_KEY_PATH: z.string().default(".local/jwt-private.pem"),
    JWT_PUBLIC_KEY_PATH: z.string().default(".local/jwt-public.pem"),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
    JWT_REFRESH_REMEMBER_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(2592000),
    PASSWORD_RESET_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(1800),
    VERIFICATION_CODE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600)
      .default(600),
    VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600)
      .default(60),
    VERIFICATION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .positive()
      .max(20)
      .default(5),
    MFA_CHALLENGE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(900)
      .default(300),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).default(65_536),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),
    REFRESH_COOKIE_NAME: z.string().default("ee_refresh"),
    COOKIE_SECURE: booleanValue,
    COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    COOKIE_SIGNING_SECRET: z
      .string()
      .min(32)
      .default("development-only-cookie-secret-change-me"),
    ENCRYPTION_MASTER_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .default(
        "0000000000000000000000000000000000000000000000000000000000000000",
      ),
    MEDIA_ROOT: z.string().default(".local/media"),
    MEDIA_PUBLIC_ORIGIN: z
      .string()
      .url()
      .default("http://localhost:4000/media"),
    MEDIA_SIGNING_SECRET: z
      .string()
      .min(32)
      .default("development-only-media-signing-secret"),
    MEDIA_MAX_IMAGE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    MEDIA_MAX_DOCUMENT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 1024 * 1024),
    MEDIA_PRIVATE_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(900),
    BACKUP_ROOT: z.string().default(".local/backups"),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    BACKUP_OFFSITE_ROOT: z.string().default(""),
    BKASH_ENABLED: booleanValue,
    BKASH_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
    BKASH_SANDBOX_BASE_URL: z
      .string()
      .url()
      .default("https://checkout.sandbox.bka.sh/v1.2.0-beta"),
    BKASH_LIVE_BASE_URL: z
      .string()
      .url()
      .default("https://checkout.pay.bka.sh/v1.2.0-beta"),
    BKASH_CALLBACK_ORIGIN: z.string().url().default("http://localhost:3000"),
    BKASH_HTTP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(30000)
      .default(8000),
    INTEGRATION_ALLOWED_HOSTS: z
      .string()
      .default("checkout.sandbox.bka.sh,checkout.pay.bka.sh"),
    METRICS_BEARER_TOKEN: z.string().default(""),
    STORE_NAME: z.string().min(1).max(100).default("Elite Emporium"),
    OWNER_NAME: z.string().default("Elite Emporium Owner"),
    OWNER_PHONE: z.string().default("+8801700000000"),
    OWNER_EMAIL: z.string().email().default("owner@example.com"),
    OWNER_PASSWORD: z.string().min(8).default("ChangeMe123!"),
    RELEASE_VERSION: z.string().default("0.1.0"),
    BUILD_SHA: z.string().default("local"),
  })
  .superRefine((value, context) => {
    if (value.COOKIE_SAME_SITE === "none" && !value.COOKIE_SECURE) {
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "must be true when COOKIE_SAME_SITE=none",
      });
    }
    if (value.NODE_ENV !== "production") return;
    if (!value.PUBLIC_ORIGIN.startsWith("https://"))
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ORIGIN"],
        message: "must use HTTPS in production",
      });
    if (!value.COOKIE_SECURE)
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "must be true in production",
      });
    if (value.REDIS_OPTIONAL)
      context.addIssue({
        code: "custom",
        path: ["REDIS_OPTIONAL"],
        message: "must be false in production",
      });
    if (
      value.COOKIE_SIGNING_SECRET ===
        "development-only-cookie-secret-change-me" ||
      value.COOKIE_SIGNING_SECRET.includes("replace-with")
    )
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SIGNING_SECRET"],
        message: "must be replaced in production",
      });
    if (/^0+$/.test(value.ENCRYPTION_MASTER_KEY))
      context.addIssue({
        code: "custom",
        path: ["ENCRYPTION_MASTER_KEY"],
        message: "must be replaced in production",
      });
    if (value.MEDIA_SIGNING_SECRET === "development-only-media-signing-secret")
      context.addIssue({
        code: "custom",
        path: ["MEDIA_SIGNING_SECRET"],
        message: "must be replaced in production",
      });
    if (!path.isAbsolute(value.MEDIA_ROOT))
      context.addIssue({
        code: "custom",
        path: ["MEDIA_ROOT"],
        message: "must be an absolute persistent path in production",
      });
    if (!path.isAbsolute(value.BACKUP_ROOT))
      context.addIssue({
        code: "custom",
        path: ["BACKUP_ROOT"],
        message: "must be an absolute persistent path in production",
      });
    if (!value.MEDIA_PUBLIC_ORIGIN.startsWith("https://"))
      context.addIssue({
        code: "custom",
        path: ["MEDIA_PUBLIC_ORIGIN"],
        message: "must use HTTPS in production",
      });
    if (
      value.BKASH_ENABLED &&
      value.BKASH_CALLBACK_ORIGIN !== value.PUBLIC_ORIGIN
    )
      context.addIssue({
        code: "custom",
        path: ["BKASH_CALLBACK_ORIGIN"],
        message: "must match PUBLIC_ORIGIN when bKash is enabled",
      });
    if (
      ["elite-emporium-local", "change-me"].includes(value.DB_PASSWORD) ||
      value.DB_PASSWORD.startsWith("replace-")
    )
      context.addIssue({
        code: "custom",
        path: ["DB_PASSWORD"],
        message: "must be replaced in production",
      });
    if (
      value.OWNER_PASSWORD === "ChangeMe123!" ||
      value.OWNER_PASSWORD.startsWith("replace-")
    )
      context.addIssue({
        code: "custom",
        path: ["OWNER_PASSWORD"],
        message: "must be replaced before production seed",
      });
    if (
      !value.METRICS_BEARER_TOKEN ||
      value.METRICS_BEARER_TOKEN.startsWith("replace-with")
    )
      context.addIssue({
        code: "custom",
        path: ["METRICS_BEARER_TOKEN"],
        message: "must be replaced in production",
      });
  });

const result = schema.safeParse(process.env);
if (!result.success) {
  const message = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${message}`);
}

export const env = Object.freeze(result.data);
