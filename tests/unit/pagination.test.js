import { describe, expect, it } from "vitest";
import { pagination } from "../../src/lib/pagination.js";

describe("pagination", () => {
  it("uses defaults for missing or invalid values", () => {
    expect(pagination({})).toEqual({
      page: 1,
      pageSize: 20,
      limit: 20,
      offset: 0,
    });
    expect(pagination({ page: "abc", pageSize: "-4" }).page).toBe(1);
  });

  it("always yields integer SQL limit/offset values", () => {
    expect(pagination({ page: "2.5", pageSize: "7.9" })).toEqual({
      page: 2,
      pageSize: 7,
      limit: 7,
      offset: 7,
    });
  });

  it("bounds non-finite pages and oversized page sizes", () => {
    const result = pagination({ page: "1e400", pageSize: "5000" });
    expect(Number.isFinite(result.offset)).toBe(true);
    expect(result.pageSize).toBe(100);
  });
});
