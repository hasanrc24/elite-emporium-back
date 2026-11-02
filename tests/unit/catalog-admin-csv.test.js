import { describe, expect, it } from "vitest";
import {
  mergedVariantErrors,
  parseCsv,
  parseImportRow,
  toCsv,
} from "../../src/modules/catalog/product-csv.js";

describe("product csv", () => {
  it("round-trips quotes, commas and newlines", () => {
    const text = toCsv([["a", 'b "q", c', "line\nbreak"]]);
    expect(parseCsv(text)).toEqual([["a", 'b "q", c', "line\nbreak"]]);
  });

  it("neutralizes spreadsheet formulas on export", () => {
    expect(toCsv([["=SUM(A1)", "+1", "ok"]])).toBe(`"'=SUM(A1)","'+1","ok"\n`);
  });

  it("parses CRLF files with a BOM and skips blank lines", () => {
    expect(parseCsv("﻿sku,on_hand\r\nA-1,5\r\n\r\n")).toEqual([
      ["sku", "on_hand"],
      ["A-1", "5"],
    ]);
  });

  it("validates import rows", () => {
    const { changes, errors } = parseImportRow({
      regular_price: "1200.5",
      sale_price: "none",
      on_hand: "12",
      low_stock_threshold: "inherit",
      sale_starts_at: "2027-03-01T00:00:00Z",
      stock_policy: "deny",
    });
    expect(errors).toEqual({});
    expect(changes).toMatchObject({
      regularPrice: "1200.50",
      salePrice: null,
      onHand: 12,
      lowStockThreshold: null,
      stockPolicy: "deny",
    });
    const bad = parseImportRow({
      regular_price: "12.345",
      on_hand: "-1",
      sale_ends_at: "tomorrow",
      stock_policy: "x",
    });
    expect(Object.keys(bad.errors).sort()).toEqual([
      "on_hand",
      "regular_price",
      "sale_ends_at",
      "stock_policy",
    ]);
  });

  it("checks sale against the merged price", () => {
    const current = {
      regularPrice: "1000.00",
      salePrice: null,
      saleStartsAt: null,
      saleEndsAt: null,
      stockPolicy: "deny",
      preorderAvailableAt: null,
    };
    expect(mergedVariantErrors(current, { salePrice: "900.00" })).toEqual({});
    expect(
      mergedVariantErrors(current, { salePrice: "1000.00" }).sale_price,
    ).toBeTruthy();
    expect(
      mergedVariantErrors(
        { ...current, salePrice: "900.00" },
        { regularPrice: "800.00" },
      ).sale_price,
    ).toBeTruthy();
  });
});
