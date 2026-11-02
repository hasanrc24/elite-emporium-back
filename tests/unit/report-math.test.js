import { describe, expect, it } from "vitest";
import { outcomeRates } from "../../src/modules/admin/report-math.js";

describe("order outcome rates", () => {
  it("measures each rate against its own denominator", () => {
    expect(
      outcomeRates({
        orders: "20",
        needsConfirmation: "16",
        confirmed: "12",
        cancelled: "3",
        delivered: "9",
        rto: "1",
      }),
    ).toEqual({
      orders: 20,
      needsConfirmation: 16,
      confirmed: 12,
      cancelled: 3,
      delivered: 9,
      rto: 1,
      confirmationRate: 75,
      cancellationRate: 15,
      rtoRate: 10,
    });
  });

  it("returns zero rates instead of dividing by zero", () => {
    const rates = outcomeRates({ orders: 0 });
    expect(rates.confirmationRate).toBe(0);
    expect(rates.cancellationRate).toBe(0);
    expect(rates.rtoRate).toBe(0);
  });

  it("rounds to one decimal place", () => {
    expect(outcomeRates({ orders: 3, cancelled: 1 }).cancellationRate).toBe(
      33.3,
    );
  });
});
