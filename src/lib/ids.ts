import { ulid } from "ulid";
import { randomBytes } from "node:crypto";

export const newId = () => ulid();
export const orderReference = () =>
  `EE-${randomBytes(8).toString("base64url").toUpperCase()}`;
export const returnReference = () =>
  `RTN-${randomBytes(8).toString("base64url").toUpperCase()}`;
export const randomToken = (bytes: number = 32) =>
  randomBytes(bytes).toString("base64url");
