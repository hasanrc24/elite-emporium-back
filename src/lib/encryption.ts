import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const key = Buffer.from(env.ENCRYPTION_MASTER_KEY, "hex");

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret<T = RuntimeValue>(envelope: unknown): T {
  const [version, ivValue, tagValue, ciphertextValue] =
    String(envelope).split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue)
    throw new Error("Unsupported encrypted secret envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function maskSecret(value: unknown): string {
  const text = String(value || "");
  if (text.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
}
