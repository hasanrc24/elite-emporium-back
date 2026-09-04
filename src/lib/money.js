import { Decimal } from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export const money = (value) => new Decimal(value || 0).toDecimalPlaces(2);
export const moneyString = (value) => money(value).toFixed(2);
export const lineTotal = (unit, quantity) => money(unit).mul(quantity).toDecimalPlaces(2);
