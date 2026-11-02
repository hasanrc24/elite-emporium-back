const percent = (part: unknown, whole: number) =>
  whole ? Math.round((Number(part || 0) / whole) * 1000) / 10 : 0;

/**
 * Pure rates for the order outcomes report (BR-REP-001). Confirmation rate
 * counts only orders that entered the queue; RTO rate is measured against
 * parcels that reached a final delivery outcome.
 */
export function outcomeRates(row: Record<string, unknown>) {
  const orders = Number(row.orders || 0);
  const needsConfirmation = Number(row.needsConfirmation || 0);
  const delivered = Number(row.delivered || 0);
  const rto = Number(row.rto || 0);
  return {
    orders,
    needsConfirmation,
    confirmed: Number(row.confirmed || 0),
    cancelled: Number(row.cancelled || 0),
    delivered,
    rto,
    confirmationRate: percent(row.confirmed, needsConfirmation),
    cancellationRate: percent(row.cancelled, orders),
    rtoRate: percent(rto, delivered + rto),
  };
}
