import { describe, expect, it } from "vitest";
import {
  effectivePrice,
  isSaleActive,
  priceDto,
} from "../../src/modules/catalog/pricing.js";

const base = { regularPrice: "1000.00", salePrice: "800.00" };

describe("pricing", () => {
  it("applies a sale without a schedule", () => {
    expect(isSaleActive(base)).toBe(true);
    expect(effectivePrice(base).toFixed(2)).toBe("800.00");
  });

  it("treats the start as inclusive and the end as exclusive (UTC)", () => {
    const sale = {
      ...base,
      saleStartsAt: "2027-03-01T00:00:00Z",
      saleEndsAt: "2027-03-02T00:00:00Z",
    };
    expect(isSaleActive(sale, new Date("2027-02-28T23:59:59Z"))).toBe(false);
    expect(isSaleActive(sale, new Date("2027-03-01T00:00:00Z"))).toBe(true);
    expect(isSaleActive(sale, new Date("2027-03-02T00:00:00Z"))).toBe(false);
  });

  it("ignores a sale that is not below the regular price", () => {
    expect(isSaleActive({ ...base, salePrice: "1000.00" })).toBe(false);
    expect(priceDto({ ...base, salePrice: "1200.00" }).price).toBe("1000.00");
  });

  it("does not discount forever when a schedule bound is unparseable", () => {
    expect(isSaleActive({ ...base, saleEndsAt: "not-a-date" })).toBe(false);
  });

  it("keeps decimal precision", () => {
    const dto = priceDto({ regularPrice: "0.30", salePrice: "0.10" });
    expect(dto.price).toBe("0.10");
    expect(dto.onSale).toBe(true);
  });
});
