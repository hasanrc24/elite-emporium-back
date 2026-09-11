import { money, moneyString } from "../../lib/money.js";
import type { Decimal } from "decimal.js";

const REFUND_CAPACITY_STATUSES = Object.freeze([
  "pending",
  "processing",
  "completed",
]);

export function calculatePaymentRefundCapacity(
  paymentAmount: Decimal.Value,
  refunds: Array<{ status: string; amount: Decimal.Value }>,
) {
  const completed = refunds
    .filter((refund) => refund.status === "completed")
    .reduce((sum, refund) => sum.plus(refund.amount), money(0));
  const committed = refunds
    .filter((refund) => REFUND_CAPACITY_STATUSES.includes(refund.status))
    .reduce((sum, refund) => sum.plus(refund.amount), money(0));
  const remaining = money(paymentAmount).minus(committed);
  return {
    captured: moneyString(paymentAmount),
    completed: moneyString(completed),
    committed: moneyString(committed),
    maximumRefundable: moneyString(remaining.isNegative() ? 0 : remaining),
  };
}
