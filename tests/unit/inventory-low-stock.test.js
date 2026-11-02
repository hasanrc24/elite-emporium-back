import { describe, expect, it } from "vitest";
import { resolveLowStockThreshold } from "../../src/modules/inventory/low-stock.js";

describe("resolveLowStockThreshold", () => {
  it("prefers variant, then product, then global", () => {
    expect(
      resolveLowStockThreshold({ variant: 1, product: 5, global: 9 }),
    ).toBe(1);
    expect(
      resolveLowStockThreshold({ variant: null, product: 5, global: 9 }),
    ).toBe(5);
    expect(resolveLowStockThreshold({ product: null, global: 9 })).toBe(9);
  });

  it("treats zero as an explicit value and ignores invalid input", () => {
    expect(
      resolveLowStockThreshold({ variant: 0, product: 5, global: 9 }),
    ).toBe(0);
    expect(
      resolveLowStockThreshold({ variant: -2, product: "x", global: 7 }),
    ).toBe(7);
  });

  it("falls back to 3 when nothing is configured", () => {
    expect(resolveLowStockThreshold({})).toBe(3);
  });
});
