import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export const money = (value: Decimal.Value | null | undefined) =>
  new Decimal(value || 0).toDecimalPlaces(2);
export const moneyString = (value: Decimal.Value | null | undefined) =>
  money(value).toFixed(2);
export const lineTotal = (unit: Decimal.Value, quantity: Decimal.Value) =>
  money(unit).mul(quantity).toDecimalPlaces(2);
