import { Op } from "sequelize";
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  ProductVariant,
} from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { settingValue } from "../settings/settings.service.js";
import { allocateHold, holdExpiry, matchHolds } from "./exchange-hold.js";

type Alternatives = Map<string, RuntimeValue[]>;

async function writeMovement(
  level: RuntimeValue,
  reservedDelta: number,
  reason: string,
  correlationId: string,
  orderId: string | null,
  transaction: RuntimeValue,
) {
  await InventoryMovement.create(
    {
      id: newId(),
      variantId: level.variantId,
      locationId: level.locationId,
      orderId,
      quantityDelta: 0,
      reservedDelta,
      onHandBefore: Number(level.onHand),
      balanceAfter: Number(level.onHand),
      reservedAfter: Number(level.reserved),
      reason,
      correlationId,
    },
    { transaction },
  );
}

function alternativeSizes(
  options: RuntimeValue[] | undefined,
  item: RuntimeValue,
) {
  const titles = (options || [])
    .filter(
      (option) =>
        option.available && option.variantId !== item.requestedVariantId,
    )
    .map((option) => option.title);
  return titles.length ? `Available: ${titles.join(", ")}.` : "";
}

/**
 * Reserves the requested replacement size for every exchange item. A size
 * that cannot be fully covered fails the whole request with the other
 * available sizes so the customer can choose again. Variants that allow
 * backorders never block the request.
 */
export async function holdExchangeStock(
  items: RuntimeValue[],
  alternatives: Alternatives,
  transaction: RuntimeValue,
) {
  const settings: RuntimeValue = await settingValue("returns", transaction);
  const expiresAt = holdExpiry(settings);
  // Variant order keeps lock acquisition consistent across concurrent holds.
  const wanted = items
    .filter((item) => item.requestedVariantId)
    .sort((a, b) =>
      String(a.requestedVariantId).localeCompare(b.requestedVariantId),
    );
  for (const item of wanted) {
    const existing = await InventoryReservation.count({
      where: { returnItemId: item.id, status: "active" },
      transaction,
    });
    if (existing) continue;
    const variant: RuntimeValue = await ProductVariant.findByPk(
      item.requestedVariantId,
      { attributes: ["id", "sku", "stockPolicy"], transaction },
    );
    const levels: RuntimeValue[] = await InventoryLevel.findAll({
      where: { variantId: item.requestedVariantId },
      order: [["locationId", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const { allocations, short } = allocateHold(
      levels.map((level) => ({
        id: level.id,
        onHand: Number(level.onHand),
        reserved: Number(level.reserved),
      })),
      Number(item.quantity),
    );
    if (short > 0 && variant?.stockPolicy === "deny")
      throw AppError.unprocessable(
        "EXCHANGE_HOLD_UNAVAILABLE",
        "The size you chose is no longer available. Pick another available size.",
        {
          requestedVariantId: [
            alternativeSizes(alternatives.get(item.orderItemId), item) ||
              "No other size is available right now.",
          ],
        },
      );
    for (const allocation of allocations) {
      const level = levels.find((value) => value.id === allocation.levelId)!;
      level.reserved = Number(level.reserved) + allocation.quantity;
      level.version = Number(level.version) + 1;
      await level.save({ transaction });
      const reservation: RuntimeValue = await InventoryReservation.create(
        {
          id: newId(),
          variantId: level.variantId,
          locationId: level.locationId,
          returnItemId: item.id,
          quantity: allocation.quantity,
          status: "active",
          expiresAt,
          idempotencyKey: `exchange-hold:${item.id}`.slice(0, 150),
        },
        { transaction },
      );
      await writeMovement(
        level,
        allocation.quantity,
        "exchange_hold",
        reservation.id,
        null,
        transaction,
      );
    }
  }
}

async function activeHolds(returnItemIds: string[], transaction: RuntimeValue) {
  if (!returnItemIds.length) return [];
  return InventoryReservation.findAll({
    where: { returnItemId: { [Op.in]: returnItemIds }, status: "active" },
    order: [
      ["variantId", "ASC"],
      ["locationId", "ASC"],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
}

async function releaseReservation(
  reservation: RuntimeValue,
  status: "released" | "expired",
  transaction: RuntimeValue,
) {
  const level: RuntimeValue = await InventoryLevel.findOne({
    where: {
      variantId: reservation.variantId,
      locationId: reservation.locationId,
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (level) {
    level.reserved = Math.max(
      0,
      Number(level.reserved) - Number(reservation.quantity),
    );
    level.version = Number(level.version) + 1;
    await level.save({ transaction });
    await writeMovement(
      level,
      -Number(reservation.quantity),
      "exchange_hold_released",
      reservation.id,
      null,
      transaction,
    );
  }
  reservation.status = status;
  reservation.releasedAt = new Date();
  await reservation.save({ transaction });
}

/** Releases every active hold of a return exactly once (reject, cancel). */
export async function releaseExchangeHolds(
  returnItemIds: string[],
  transaction: RuntimeValue,
) {
  const holds = await activeHolds(returnItemIds, transaction);
  for (const hold of holds)
    await releaseReservation(hold, "released", transaction);
  return holds.length;
}

/**
 * Hands holds to the replacement order. Holds that match a replacement line
 * become that order's converted reservations (so cancelling or packing it
 * works like any order); the rest are released.
 */
export async function convertExchangeHolds(
  returnItemIds: string[],
  replacementOrderId: string,
  lines: { variantId: string; quantity: number }[],
  transaction: RuntimeValue,
) {
  const holds = await activeHolds(returnItemIds, transaction);
  const { convert, release } = matchHolds(
    holds.map((hold: RuntimeValue) => ({
      id: hold.id,
      variantId: hold.variantId,
      quantity: Number(hold.quantity),
    })),
    lines,
  );
  const now = new Date();
  for (const hold of holds) {
    if (release.includes(hold.id))
      await releaseReservation(hold, "released", transaction);
    else if (convert.includes(hold.id)) {
      hold.orderId = replacementOrderId;
      hold.returnItemId = null;
      hold.status = "converted";
      hold.convertedAt = now;
      hold.expiresAt = new Date(now.getTime() + 365 * 86400000);
      await hold.save({ transaction });
    }
  }
  return convert.length;
}
