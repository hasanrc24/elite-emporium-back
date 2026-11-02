import { Op, type Transaction } from "sequelize";
import {
  Permission,
  Role,
  StaffNotification,
  User,
  UserPermissionOverride,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { effectivePermissionKeys } from "../auth/authorization.js";
import { queueNotification } from "../events/outbox.service.js";
import {
  parseStaffRecipient,
  staffNotificationContent,
  type StaffAudience,
} from "./staff-notification.rules.js";

interface StaffAlert {
  event: string;
  title: string;
  message?: string | null;
  link?: string | null;
  severity?: "info" | "success" | "warning" | "critical";
  /** Collapses repeats into the recipient's existing unread alert. */
  dedupeKey?: string | null;
  data?: Record<string, unknown>;
  transaction?: Transaction | null;
}

function staffPayload({
  title,
  message,
  link,
  severity = "info",
  dedupeKey,
  data = {},
}: StaffAlert) {
  return {
    ...data,
    title,
    message: message || title,
    ...(link ? { link } : {}),
    severity,
    ...(dedupeKey ? { dedupeKey } : {}),
  };
}

/** Queues a dashboard alert for every staff member in the audience. */
export function notifyStaff(audience: StaffAudience, alert: StaffAlert) {
  return queueNotification({
    event: alert.event,
    channel: "dashboard",
    recipient: `staff:${audience}`,
    payload: staffPayload(alert),
    transaction: alert.transaction,
  });
}

/** Queues a dashboard alert for one staff member, e.g. their own export. */
export function notifyStaffMember(
  userId: string,
  permission: string | null,
  alert: StaffAlert,
) {
  return queueNotification({
    event: alert.event,
    channel: "dashboard",
    recipient: `user:${userId}`,
    payload: { ...staffPayload(alert), ...(permission ? { permission } : {}) },
    transaction: alert.transaction,
  });
}

export function queueLowStockAlert({
  variantId,
  sku,
  available,
  threshold,
  transaction,
}: {
  variantId: string;
  sku: string;
  available: number;
  threshold: number;
  transaction?: Transaction | null;
}) {
  const out = available <= 0;
  return notifyStaff("inventory", {
    event: "inventory.low_stock",
    title: out ? `${sku} is out of stock` : `${sku} is running low`,
    message: out
      ? `No sellable units of ${sku} are left.`
      : `${available} sellable unit${available === 1 ? "" : "s"} left (alert threshold ${threshold}).`,
    link: `/admin/inventory?search=${encodeURIComponent(sku)}`,
    severity: out ? "critical" : "warning",
    dedupeKey: `inventory.low_stock:${variantId}`,
    data: { sku, available },
    transaction,
  });
}

async function staffRecipientIds(
  permission: string | null,
  userId: string | null,
): Promise<string[]> {
  const users: RuntimeValue = await User.findAll({
    where: { status: "active", ...(userId ? { id: userId } : {}) },
    attributes: ["id"],
    include: [
      {
        model: Role,
        as: "roles",
        where: { active: true, key: { [Op.ne]: "customer" } },
        required: true,
        attributes: ["id", "key"],
        through: { attributes: [] },
        include: [
          {
            model: Permission,
            as: "permissions",
            attributes: ["id", "key"],
            through: { attributes: [], where: { allow: true } },
          },
        ],
      },
      {
        model: UserPermissionOverride,
        as: "permissionOverrides",
        required: false,
        include: [{ model: Permission, as: "permission", attributes: ["key"] }],
      },
    ],
  });
  return users
    .filter((user: RuntimeValue) => {
      const keys = new Set(effectivePermissionKeys(user));
      return keys.has("admin.access") && (!permission || keys.has(permission));
    })
    .map((user: RuntimeValue) => user.id);
}

/**
 * Worker delivery for the `dashboard` channel: writes one inbox row per
 * eligible staff member. Safe to retry: the (outboxId, userId) unique key and
 * the outbox check on merged rows keep a re-run from duplicating alerts.
 */
export async function deliverStaffNotification(
  row: RuntimeValue,
  rendered: { subject?: string | null; body?: string | null },
) {
  const payload = row.payload || {};
  const target = parseStaffRecipient(row.recipient, payload);
  if (!target)
    throw Object.assign(new Error("Unknown dashboard recipient."), {
      code: "RECIPIENT_INVALID",
      permanent: true,
    });
  const content = staffNotificationContent(row.event, rendered, payload);
  const userIds = await staffRecipientIds(target.permission, target.userId);
  if (!userIds.length) return 0;
  const now = new Date();
  const fields = {
    event: row.event,
    category: content.category,
    severity: content.severity,
    permission: target.permission,
    title: content.title,
    body: content.body,
    link: content.link,
  };
  await sequelize.transaction(async (transaction: RuntimeValue) => {
    let fresh = userIds;
    if (content.dedupeKey) {
      const open: RuntimeValue = await StaffNotification.findAll({
        where: {
          userId: { [Op.in]: userIds },
          dedupeKey: content.dedupeKey,
          readAt: null,
        },
        attributes: ["id", "userId", "outboxId"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const merged = new Set(open.map((item: RuntimeValue) => item.userId));
      fresh = userIds.filter((id) => !merged.has(id));
      const bump = open
        .filter((item: RuntimeValue) => item.outboxId !== row.id)
        .map((item: RuntimeValue) => item.id);
      if (bump.length)
        await StaffNotification.update(
          {
            ...fields,
            outboxId: row.id,
            occurredAt: now,
            occurrences: sequelize.literal("occurrences + 1"),
          },
          { where: { id: { [Op.in]: bump } }, transaction },
        );
    }
    if (fresh.length)
      await StaffNotification.bulkCreate(
        fresh.map((userId) => ({
          id: newId(),
          userId,
          outboxId: row.id,
          ...fields,
          dedupeKey: content.dedupeKey,
          occurrences: 1,
          occurredAt: now,
          readAt: null,
        })),
        { transaction, ignoreDuplicates: true },
      );
  });
  return userIds.length;
}

function notificationDto(row: RuntimeValue) {
  return {
    id: row.id,
    event: row.event,
    category: row.category,
    severity: row.severity,
    title: row.title,
    body: row.body,
    link: row.link,
    occurrences: Number(row.occurrences),
    occurredAt: row.occurredAt,
    readAt: row.readAt,
  };
}

type Viewer = { user: { id: string }; permissions: Set<string> };

function visibleTo(viewer: Viewer): RuntimeValue {
  return {
    userId: viewer.user.id,
    [Op.or]: [
      { permission: null },
      { permission: { [Op.in]: [...viewer.permissions] } },
    ],
  };
}

function unreadCount(viewer: Viewer) {
  return StaffNotification.count({
    where: { ...visibleTo(viewer), readAt: null },
  });
}

export async function listStaffNotifications(
  viewer: Viewer,
  query: RuntimeValue,
) {
  const { page, pageSize, limit, offset } = pagination(query, 50);
  const where = {
    ...visibleTo(viewer),
    ...(query.status === "unread" ? { readAt: null } : {}),
    ...(query.category ? { category: query.category } : {}),
  };
  const [result, unread]: RuntimeValue = await Promise.all([
    StaffNotification.findAndCountAll({
      where,
      order: [
        ["occurredAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    }),
    unreadCount(viewer),
  ]);
  const envelope = pageEnvelope(result, page, pageSize);
  return {
    data: result.rows.map(notificationDto),
    meta: { ...envelope.meta, unreadCount: unread },
  };
}

/** Cheap poll target for the admin bell. */
export async function staffNotificationSummary(viewer: Viewer) {
  const [unread, latest]: RuntimeValue = await Promise.all([
    unreadCount(viewer),
    StaffNotification.findOne({
      where: { ...visibleTo(viewer), readAt: null },
      order: [
        ["occurredAt", "DESC"],
        ["id", "DESC"],
      ],
    }),
  ]);
  return {
    unreadCount: unread,
    latest: latest ? notificationDto(latest) : null,
  };
}

export async function setStaffNotificationRead(
  viewer: Viewer,
  id: string,
  read: boolean,
) {
  const row: RuntimeValue = await StaffNotification.findOne({
    where: { ...visibleTo(viewer), id },
  });
  if (!row) throw AppError.notFound("Notification not found.");
  if (read !== Boolean(row.readAt))
    await row.update({ readAt: read ? new Date() : null });
  return notificationDto(row);
}

/**
 * `before` keeps alerts that arrived after the person last looked unread.
 */
export async function markAllStaffNotificationsRead(
  viewer: Viewer,
  { before }: { before?: string | Date } = {},
) {
  const cutoff = before ? new Date(before) : new Date();
  const [updated] = await StaffNotification.update(
    { readAt: new Date() },
    {
      where: {
        ...visibleTo(viewer),
        readAt: null,
        occurredAt: { [Op.lte]: cutoff },
      },
    },
  );
  return { updated };
}

const day = 24 * 60 * 60 * 1000;

/** Retention: read alerts for 90 days, everything for 180 days. */
export async function purgeStaffNotifications(now: Date = new Date()) {
  return StaffNotification.destroy({
    where: {
      [Op.or]: [
        { readAt: { [Op.lt]: new Date(now.getTime() - 90 * day) } },
        { occurredAt: { [Op.lt]: new Date(now.getTime() - 180 * day) } },
      ],
    },
    limit: 5000,
  });
}
