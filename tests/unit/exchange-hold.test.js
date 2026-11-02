import { describe, expect, it } from "vitest";
import {
  allocateHold,
  holdExpiry,
  holdTrigger,
  matchHolds,
} from "../../src/modules/returns/exchange-hold.js";

describe("exchange hold rules", () => {
  it("expires after the configured hours, defaulting to 72", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(holdExpiry({}, now).toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(holdExpiry({ exchangeHoldHours: 24 }, now).toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
  it("holds on request unless configured for approval", () => {
    expect(holdTrigger({})).toBe("request");
    expect(holdTrigger({ holdOn: "approval" })).toBe("approval");
  });
  it("allocates across locations and reports the shortfall", () => {
    const levels = [
      { id: "a", onHand: 2, reserved: 1 },
      { id: "b", onHand: 3, reserved: 0 },
    ];
    expect(allocateHold(levels, 3)).toEqual({
      allocations: [
        { levelId: "a", quantity: 1 },
        { levelId: "b", quantity: 2 },
      ],
      short: 0,
    });
    expect(allocateHold(levels, 6).short).toBe(2);
  });
  it("converts holds that match replacement lines and releases the rest", () => {
    const holds = [
      { id: "h1", variantId: "v1", quantity: 1 },
      { id: "h2", variantId: "v2", quantity: 1 },
    ];
    expect(matchHolds(holds, [{ variantId: "v1", quantity: 1 }])).toEqual({
      convert: ["h1"],
      release: ["h2"],
    });
  });
});
