import { ShippingMethod, ShippingZone } from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { money, moneyString } from "../../lib/money.js";
import type { Decimal } from "decimal.js";
import type { FindOptions, Transaction } from "sequelize";
import type { DynamicModel } from "../../db/models/shared.js";

export async function listPublicShippingMethods(
  locale: string = "en",
  paymentMethod: string | null = null,
  subtotal: Decimal.Value = 0,
) {
  const rows: RuntimeValue = await ShippingMethod.findAll({
    where: { active: true },
    include: [{ model: ShippingZone, as: "zone", where: { active: true } }],
    order: [["displayOrder", "ASC"]],
  });
  return rows
    .filter(
      (row: RuntimeValue) =>
        !paymentMethod ||
        !Array.isArray(row.allowedPayments) ||
        row.allowedPayments.includes(paymentMethod),
    )
    .map((row: RuntimeValue) => shippingMethodDto(row, locale, subtotal));
}

function shippingMethodDto(
  method: DynamicModel,
  locale: string = "en",
  subtotal: Decimal.Value = 0,
) {
  const free =
    method.type === "free" ||
    (method.freeThreshold != null &&
      money(subtotal).greaterThanOrEqualTo(method.freeThreshold));
  const price: RuntimeValue = free ? money(0) : money(method.flatRate);
  return {
    id: method.id,
    code: method.code,
    zoneCode: method.zone?.code,
    label: locale === "bn" ? method.labelBn : method.labelEn,
    labels: { en: method.labelEn, bn: method.labelBn },
    price: moneyString(price),
    regularPrice: moneyString(method.flatRate),
    free,
    freeThreshold:
      method.freeThreshold == null ? null : moneyString(method.freeThreshold),
    allowedPayments: method.allowedPayments || [],
  };
}

export async function resolveShippingMethod(
  code: string,
  paymentMethod: string,
  subtotal: Decimal.Value,
  locale: string = "en",
  transaction: Transaction | null = null,
  lock: FindOptions["lock"] = undefined,
) {
  const method: RuntimeValue = await ShippingMethod.findOne({
    where: { code, active: true },
    include: [{ model: ShippingZone, as: "zone", where: { active: true } }],
    transaction,
    lock,
  });
  if (!method)
    throw AppError.unprocessable(
      "INVALID_SHIPPING_METHOD",
      "Select an available delivery option.",
      { deliveryCode: ["Select an available delivery option."] },
    );
  if (
    Array.isArray(method.allowedPayments) &&
    method.allowedPayments.length &&
    !method.allowedPayments.includes(paymentMethod)
  )
    throw AppError.unprocessable(
      "PAYMENT_NOT_ALLOWED_FOR_DELIVERY",
      "The selected payment method is not available for this delivery option.",
    );
  return { model: method, ...shippingMethodDto(method, locale, subtotal) };
}
