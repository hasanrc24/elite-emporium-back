/**
 * Staff audiences for dashboard alerts (BR-NOTIFY-001). An outbox row
 * addressed to `staff:<audience>` reaches every active staff member holding
 * the mapped permission; `user:<id>` reaches one staff member.
 */
const staffAudiences = {
  orders: "orders.view",
  payments: "payments.view",
  returns: "returns.view",
  inventory: "inventory.view",
  catalog: "catalog.publish",
  support: "customers.view",
  platform: "notifications.manage",
  webhooks: "webhooks.manage",
} as const;

export type StaffAudience = keyof typeof staffAudiences;

const staffSeverities = ["info", "success", "warning", "critical"];

export interface StaffTarget {
  userId: string | null;
  permission: string | null;
}

export function parseStaffRecipient(
  recipient: unknown,
  payload: RuntimeValue = {},
): StaffTarget | null {
  const [kind, value] = String(recipient || "").split(":", 2);
  if (kind === "staff" && Object.hasOwn(staffAudiences, value))
    return {
      userId: null,
      permission: staffAudiences[value as StaffAudience],
    };
  if (kind === "user" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value || ""))
    return {
      userId: value,
      permission:
        typeof payload?.permission === "string" ? payload.permission : null,
    };
  return null;
}

/**
 * Only same-origin admin paths are stored, so a crafted payload can never
 * turn an alert into an off-site or protocol-relative redirect.
 */
function safeAdminLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  if (!/^\/admin(?:[/?#]|$)/.test(value)) return null;
  if (value.includes("//") || value.includes("\\")) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return value;
}

const humanize = (event: string) =>
  event
    .split(/[._]/)
    .filter(Boolean)
    .join(" ")
    .replace(/^./, (first) => first.toUpperCase());

const clip = (value: unknown, length: number) => {
  const text = value == null ? "" : String(value).trim();
  return text ? text.slice(0, length) : null;
};

/** Inbox fields from a rendered template (or the payload when none exists). */
export function staffNotificationContent(
  event: string,
  rendered: { subject?: string | null; body?: string | null },
  payload: RuntimeValue = {},
) {
  const title =
    clip(rendered.subject, 255) ||
    clip(payload.title, 255) ||
    humanize(event).slice(0, 255);
  const body = clip(rendered.body, 2000);
  return {
    title,
    // A body that only repeats the title or the event code adds nothing.
    body: body === event || body === title ? null : body,
    link: safeAdminLink(payload.link),
    severity: staffSeverities.includes(payload.severity)
      ? payload.severity
      : "info",
    category: clip(payload.category, 40) || event.split(".")[0].slice(0, 40),
    dedupeKey: clip(payload.dedupeKey, 190),
  };
}

/** Alert once when stock falls to the threshold, not on every later sale. */
export function crossedLowStock(
  availableBefore: number,
  availableAfter: number,
  threshold: number,
) {
  return availableBefore > threshold && availableAfter <= threshold;
}
