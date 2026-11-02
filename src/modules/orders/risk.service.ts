import { Op } from "sequelize";
import { isIP } from "node:net";
import { ipPrefix } from "../../lib/ip-prefix.js";
import {
  Order,
  OrderConfirmation,
  OrderItem,
  RiskBlocklist,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { money } from "../../lib/money.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { settingValue } from "../settings/settings.service.js";

export type RiskInput = {
  blocked: boolean;
  rtoCount: number;
  cancelledCount: number;
  deliveredCount: number;
  wrongNumberCount: number;
  recentOrderCount: number;
  firstOrderHighValue: boolean;
  possibleDuplicate: boolean;
};

export type RiskThresholds = { mediumScore: number; highScore: number };

/**
 * Pure COD risk scoring from local order history (BE-RISK-002). Each signal
 * carries a stable code so staff see why an order was flagged.
 */
export function computeRisk(input: RiskInput, thresholds: RiskThresholds) {
  if (input.blocked)
    return { score: 100, level: "blocked" as const, signals: ["blocklisted"] };
  const signals: string[] = [];
  let score = 0;
  if (input.rtoCount > 0) {
    score += Math.min(60, input.rtoCount * 30);
    signals.push("previous_return_to_origin");
  }
  if (input.cancelledCount > 0) {
    score += Math.min(20, input.cancelledCount * 10);
    signals.push("previous_cancellations");
  }
  if (input.wrongNumberCount > 0) {
    score += 20;
    signals.push("previous_wrong_number");
  }
  if (input.recentOrderCount >= 2) {
    score += 15;
    signals.push("many_recent_orders");
  }
  if (input.firstOrderHighValue) {
    score += 20;
    signals.push("first_order_high_value");
  }
  if (input.possibleDuplicate) {
    score += 10;
    signals.push("possible_duplicate");
  }
  // A delivery history earns trust back, but never fully cancels RTOs.
  if (input.deliveredCount > 0)
    score -= Math.min(30, input.deliveredCount * 10);
  score = Math.max(0, Math.min(99, score));
  const level =
    score >= thresholds.highScore
      ? ("high" as const)
      : score >= thresholds.mediumScore
        ? ("medium" as const)
        : ("low" as const);
  return { score, level, signals };
}

async function isBlocklisted(
  phone: string | null,
  email: string | null,
  ip: string | null,
  transaction: RuntimeValue,
) {
  const values: { type: string; value: string }[] = [];
  if (phone) values.push({ type: "phone", value: phone });
  if (email) values.push({ type: "email", value: email });
  const prefix = ipPrefix(ip);
  if (prefix) values.push({ type: "ip_prefix", value: prefix });
  if (!values.length) return false;
  const hit: RuntimeValue = await RiskBlocklist.findOne({
    where: {
      active: true,
      [Op.or]: values,
      [Op.and]: [
        {
          [Op.or]: [
            { expiresAt: null },
            { expiresAt: { [Op.gt]: new Date() } },
          ],
        },
      ],
    },
    transaction,
  });
  return Boolean(hit);
}

/** Gathers history for one checkout and scores it. Never calls external services. */
export async function assessOrderRisk(
  {
    phone,
    email,
    ip = null,
    grandTotal,
    variantIds,
  }: {
    phone: string;
    email: string | null;
    ip?: string | null;
    grandTotal: RuntimeValue;
    variantIds: string[];
  },
  transaction: RuntimeValue = null,
) {
  const [risk, confirmation]: RuntimeValue = await Promise.all([
    settingValue("risk", transaction),
    settingValue("confirmation", transaction),
  ]);
  const history: RuntimeValue = await Order.findAll({
    where: { customerPhone: phone, orderStatus: { [Op.ne]: "draft" } },
    attributes: [
      "id",
      "orderStatus",
      "fulfillmentStatus",
      "createdAt",
      "cancellationReason",
    ],
    include: [{ model: OrderItem, as: "items", attributes: ["variantId"] }],
    order: [["createdAt", "DESC"]],
    limit: 50,
    transaction,
  });
  const wrongNumberCount: RuntimeValue = history.length
    ? await OrderConfirmation.count({
        where: {
          orderId: { [Op.in]: history.map((row: RuntimeValue) => row.id) },
          outcome: "wrong_number",
        },
        transaction,
      })
    : 0;
  const now = Date.now();
  const windowMs = Number(confirmation.duplicateWindowMinutes || 0) * 60000;
  const wanted = new Set(variantIds);
  const duplicate: RuntimeValue = windowMs
    ? history.find(
        (row: RuntimeValue) =>
          ["pending_payment", "placed", "confirmed", "processing"].includes(
            row.orderStatus,
          ) &&
          now - new Date(row.createdAt).getTime() <= windowMs &&
          row.items.some((item: RuntimeValue) => wanted.has(item.variantId)),
      )
    : null;
  const input: RiskInput = {
    blocked: await isBlocklisted(phone, email, ip, transaction),
    rtoCount: history.filter(
      (row: RuntimeValue) => row.fulfillmentStatus === "returned_to_origin",
    ).length,
    cancelledCount: history.filter(
      (row: RuntimeValue) =>
        row.orderStatus === "cancelled" &&
        row.fulfillmentStatus !== "returned_to_origin",
    ).length,
    deliveredCount: history.filter((row: RuntimeValue) =>
      ["delivered", "partially_returned", "returned"].includes(
        row.fulfillmentStatus,
      ),
    ).length,
    wrongNumberCount,
    recentOrderCount: history.filter(
      (row: RuntimeValue) => now - new Date(row.createdAt).getTime() < 86400000,
    ).length,
    firstOrderHighValue:
      !history.length &&
      money(grandTotal).greaterThanOrEqualTo(risk.newCustomerHighValue),
    possibleDuplicate: Boolean(duplicate),
  };
  const result = risk.enabled
    ? computeRisk(input, risk)
    : input.blocked
      ? computeRisk(input, risk)
      : { score: 0, level: "low" as const, signals: [] as string[] };
  return {
    ...result,
    duplicateOfOrderId: duplicate?.id || null,
    action: result.level === "high" ? risk.highRiskAction : null,
    confirmationEnabled: Boolean(confirmation.enabled),
  };
}

/**
 * Applies the owner's risk policy at checkout. Customers get a neutral
 * message; the reasons stay internal.
 */
export function enforceRiskPolicy(
  assessment: RuntimeValue,
  paymentMethod: string,
) {
  if (assessment.level === "blocked" || assessment.action === "block_order")
    throw AppError.unprocessable(
      "ORDER_NOT_ACCEPTED",
      "We couldn't accept this order online. Please contact us and we'll help you place it.",
    );
  if (assessment.action === "block_cod" && paymentMethod === "cod")
    throw AppError.unprocessable(
      "COD_NOT_AVAILABLE",
      "Cash on delivery isn't available for this order. Please choose online payment or contact us.",
      { paymentMethod: ["Choose online payment for this order."] },
    );
}

function blocklistDto(row: RuntimeValue) {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    reason: row.reason,
    active: row.active,
    expiresAt: row.expiresAt,
    actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listBlocklist(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.type) where.type = query.type;
  if (query.active === "true") where.active = true;
  if (query.search) where.value = { [Op.like]: likeContains(query.search, 80) };
  const result: RuntimeValue = await RiskBlocklist.findAndCountAll({
    where,
    include: [{ association: "actor", attributes: ["id", "name"] }],
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map(blocklistDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

function normalizedIpPrefix(value: string) {
  const address = value.trim().split("/")[0];
  if (isIP(address.replace(/^::ffff:/, "")) === 0) return null;
  return ipPrefix(address);
}

function normalizedBlockValue(type: string, value: string) {
  const normalized =
    type === "phone"
      ? normalizePhone(value)
      : type === "ip_prefix"
        ? normalizedIpPrefix(value)
        : normalizeEmail(value);
  if (!normalized)
    throw AppError.unprocessable(
      "INVALID_BLOCK_VALUE",
      type === "phone"
        ? "Enter a valid Bangladeshi phone number."
        : type === "ip_prefix"
          ? "Enter a valid IPv4 or IPv6 address."
          : "Enter a valid email address.",
      { value: ["Enter a valid value."] },
    );
  return normalized;
}

export async function saveBlocklistEntry(
  id: string | null,
  payload: RuntimeValue,
  actorId: string,
  request: RuntimeValue,
) {
  const value = normalizedBlockValue(payload.type, payload.value);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = id
      ? await RiskBlocklist.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : await RiskBlocklist.findOne({
          where: { type: payload.type, value },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
    if (id && !row) throw AppError.notFound("Blocklist entry not found.");
    const before = row ? blocklistDto(row) : null;
    const values = {
      type: payload.type,
      value,
      reason: payload.reason,
      active: payload.active ?? true,
      expiresAt: payload.expiresAt || null,
      actorId,
    };
    if (row) await row.update(values, { transaction });
    else
      row = await RiskBlocklist.create(
        { id: newId(), ...values },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: before ? "risk.blocklist_update" : "risk.blocklist_create",
      resourceType: "risk_blocklist",
      resourceId: row.id,
      before,
      after: blocklistDto(row),
      request,
      transaction,
    });
    return blocklistDto(row);
  });
}
