/**
 * BE-RETURN-001: a size exchange holds stock for the requested size. These
 * are the pure rules; the I/O lives in exchange-hold.service.ts.
 */
const defaultExchangeHoldHours = 72;

export type HoldSettings = { exchangeHoldHours?: number; holdOn?: string };

export function holdExpiry(settings: HoldSettings, now = new Date()) {
  const hours = Number(settings.exchangeHoldHours) || defaultExchangeHoldHours;
  return new Date(now.getTime() + hours * 3600000);
}

/** `request` (default) holds when the customer asks, `approval` when staff approve. */
export function holdTrigger(settings: HoldSettings): "request" | "approval" {
  return settings.holdOn === "approval" ? "approval" : "request";
}

export type StockLevel = { id: string; onHand: number; reserved: number };

/**
 * Greedy allocation across locations in a stable order. `short` is what could
 * not be covered.
 */
export function allocateHold(levels: StockLevel[], quantity: number) {
  const allocations: { levelId: string; quantity: number }[] = [];
  let needed = quantity;
  for (const level of levels) {
    if (needed <= 0) break;
    const take = Math.min(needed, Math.max(0, level.onHand - level.reserved));
    if (!take) continue;
    allocations.push({ levelId: level.id, quantity: take });
    needed -= take;
  }
  return { allocations, short: needed };
}

/**
 * Matches held reservations to replacement lines by variant. Quantities
 * beyond the replacement line, and holds for other variants, stay unmatched
 * so the caller can release them.
 */
export function matchHolds(
  holds: { id: string; variantId: string; quantity: number }[],
  lines: { variantId: string; quantity: number }[],
) {
  const remaining = new Map<string, number>();
  for (const line of lines)
    remaining.set(
      line.variantId,
      (remaining.get(line.variantId) || 0) + line.quantity,
    );
  const convert: string[] = [];
  const release: string[] = [];
  for (const hold of holds) {
    const left = remaining.get(hold.variantId) || 0;
    if (left >= hold.quantity) {
      remaining.set(hold.variantId, left - hold.quantity);
      convert.push(hold.id);
    } else release.push(hold.id);
  }
  return { convert, release };
}
