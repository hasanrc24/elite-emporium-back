import { describe, expect, it } from "vitest";
import {
  isNewProduct,
  searchWhereSql,
  sizeChartCells,
} from "../../src/modules/catalog/catalog.service.js";
import {
  isLoggableSearchMiss,
  normalizeSearchTerm,
} from "../../src/modules/catalog/search.service.js";

describe("size chart conversion", () => {
  it("derives inches from cm and back", () => {
    expect(sizeChartCells({ bust: 88, waist: "70" }, "cm")).toEqual({
      cm: { bust: 88, waist: 70 },
      inch: { bust: 34.6, waist: 27.6 },
    });
    expect(sizeChartCells({ bust: 34 }, "in").cm.bust).toBe(86.4);
    expect(sizeChartCells({ bad: "x" }, "cm")).toEqual({ cm: {}, inch: {} });
  });
});

describe("new product badge", () => {
  it("is true only within the window", () => {
    const now = new Date("2026-01-31T00:00:00Z");
    expect(isNewProduct("2026-01-10T00:00:00Z", now)).toBe(true);
    expect(isNewProduct("2025-11-01T00:00:00Z", now)).toBe(false);
    expect(isNewProduct(null, now)).toBe(false);
  });
});

describe("search SQL", () => {
  it("escapes LIKE wildcards and quotes in every word", () => {
    const sql = searchWhereSql(["100%_x o'neil"]).val;
    expect(sql).toContain("100\\\\%\\\\_x");
    expect(sql).not.toContain("o'neil");
    expect(sql).toContain(" AND ");
  });

  it("returns null for an empty term list", () => {
    expect(searchWhereSql([])).toBeNull();
  });
});

describe("search normalization extras", () => {
  it("drops zero-width characters", () => {
    expect(normalizeSearchTerm("ka‍miz")).toBe("kamiz");
  });
  it("does not log personal data as zero-result queries", () => {
    expect(isLoggableSearchMiss("red kurti")).toBe(true);
    expect(isLoggableSearchMiss("a@b.com")).toBe(false);
    expect(isLoggableSearchMiss("01712345678")).toBe(false);
    expect(isLoggableSearchMiss("x")).toBe(false);
  });
});
