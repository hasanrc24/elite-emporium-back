import { createHash } from "node:crypto";

/**
 * Pure rules for the Meta (Facebook) Conversions API: PII hashing, event
 * shaping, retry policy. Kept free of I/O so they can be unit tested.
 */
export const graphApiVersion = "v21.0";

/** Meta rejects events older than 7 days; stay safely inside that window. */
export const maxEventAgeMs = 6 * 24 * 3600 * 1000;
export const maxAttempts = 8;

/** Event names the browser may relay (maps to the standard Meta events). */
export const relayedEventNames = [
  "ViewContent",
  "AddToCart",
  "InitiateCheckout",
  "Search",
  "AddToWishlist",
] as const;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const clean = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

/** Meta wants lower-case, trimmed, SHA-256 hex. Empty values are dropped. */
export function hashValue(value: unknown): string | null {
  const text = clean(value);
  return text ? hash(text) : null;
}

/** Digits only, with the country code (880 for Bangladesh). */
export function hashPhone(value: unknown): string | null {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) digits = `88${digits}`;
  return /^8801\d{9}$/.test(digits) ? hash(digits) : null;
}

function hashName(value: unknown): string | null {
  // Letters (any script) only, as Meta recommends.
  const text = clean(value).replace(/[^\p{L}\p{M}]/gu, "");
  return text ? hash(text) : null;
}

export type UserInput = {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  city?: string | null;
  postcode?: string | null;
  externalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

const fbpPattern = /^fb\.\d\.\d{10,13}\.\d{1,20}$/;
const fbcPattern = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_-]{4,300}$/;
export const isFbp = (value: unknown) => fbpPattern.test(String(value ?? ""));
export const isFbc = (value: unknown) => fbcPattern.test(String(value ?? ""));

/** `user_data` for one event. Identifiers are hashed; fbp/fbc/IP/UA are sent as-is. */
export function buildUserData(input: UserInput): Record<string, unknown> {
  const parts = String(input.name ?? "")
    .trim()
    .split(/\s+/);
  const first = parts.length ? parts[0] : "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const data: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value) data[key] = Array.isArray(value) ? value : value;
  };
  set("em", hashValue(input.email) && [hashValue(input.email)]);
  set("ph", hashPhone(input.phone) && [hashPhone(input.phone)]);
  set("fn", hashName(first) && [hashName(first)]);
  set("ln", hashName(last) && [hashName(last)]);
  set("ct", hashName(input.city) && [hashName(input.city)]);
  set("zp", hashValue(input.postcode) && [hashValue(input.postcode)]);
  set("country", [hash("bd")]);
  set("external_id", input.externalId && [hash(String(input.externalId))]);
  set("client_ip_address", input.ip && String(input.ip).slice(0, 64));
  set(
    "client_user_agent",
    input.userAgent && String(input.userAgent).slice(0, 500),
  );
  if (isFbp(input.fbp)) data.fbp = input.fbp;
  if (isFbc(input.fbc)) data.fbc = input.fbc;
  return data;
}

export type ContentLine = { id: string; quantity: number; price?: string };

/** `custom_data` limited to the fields Meta understands. */
export function buildCustomData(input: {
  value?: string | number | null;
  currency?: string;
  contents?: ContentLine[];
  searchString?: string | null;
  contentName?: string | null;
  numItems?: number | null;
}): Record<string, unknown> {
  const data: Record<string, unknown> = { currency: input.currency || "BDT" };
  const value = Number(input.value);
  if (Number.isFinite(value) && value >= 0) data.value = value;
  const contents = (input.contents || [])
    .filter((line) => line.id)
    .slice(0, 50)
    .map((line) => ({
      id: String(line.id).slice(0, 100),
      quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)),
      ...(line.price != null && Number.isFinite(Number(line.price))
        ? { item_price: Number(line.price) }
        : {}),
    }));
  if (contents.length) {
    data.contents = contents;
    data.content_ids = contents.map((line) => line.id);
    data.content_type = "product";
    data.num_items =
      Number(input.numItems) || contents.reduce((n, l) => n + l.quantity, 0);
  }
  if (input.searchString)
    data.search_string = String(input.searchString).slice(0, 200);
  if (input.contentName)
    data.content_name = String(input.contentName).slice(0, 200);
  return data;
}

export type MetaEvent = {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url?: string;
  action_source: "website";
  user_data: Record<string, unknown>;
  custom_data: Record<string, unknown>;
};

export function buildEvent(input: {
  name: string;
  eventId: string;
  eventTime: Date;
  sourceUrl?: string | null;
  userData: Record<string, unknown>;
  customData: Record<string, unknown>;
}): MetaEvent {
  return {
    event_name: input.name,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    ...(input.sourceUrl
      ? { event_source_url: input.sourceUrl.slice(0, 1000) }
      : {}),
    action_source: "website",
    user_data: input.userData,
    custom_data: input.customData,
  };
}

/** Only an http(s) page on the store's own origin is a valid event source. */
export function safeSourceUrl(value: unknown, allowedOrigin: string) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.origin !== new URL(allowedOrigin).origin) return null;
    // Query strings can carry tokens or personal data; send the path only.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Exponential backoff in seconds, capped at one hour. */
export function retryDelaySeconds(attempts: number) {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

export type SendOutcome = "sent" | "retry" | "failed";

/**
 * Meta returns HTTP 4xx for bad data (never retry) and for rate limits or
 * transient errors (retry). Token errors (code 190) need staff action.
 */
export function classifyResponse(
  status: number,
  body: { error?: { code?: number; is_transient?: boolean } } | null,
): SendOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status >= 500 || status === 429 || status === 0) return "retry";
  const code = body?.error?.code;
  if (body?.error?.is_transient) return "retry";
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 80004
  )
    return "retry";
  return "failed";
}

export const isTokenError = (body: { error?: { code?: number } } | null) =>
  body?.error?.code === 190 || body?.error?.code === 102;

/** Public pixel IDs are 8–20 digits. */
export const isPixelId = (value: unknown) =>
  /^\d{8,20}$/.test(String(value ?? ""));
