import { describe, expect, it } from "vitest";
import { Op } from "sequelize";
import { dateRangeWhere } from "../../src/lib/date-range.js";

describe("dateRangeWhere", () => {
  it("uses Dhaka day boundaries and includes the complete end date", () => {
    const where = dateRangeWhere({
      from: "2026-09-01",
      to: "2026-09-05",
    }).createdAt;
    expect(where[Op.gte].toISOString()).toBe("2026-08-31T18:00:00.000Z");
    expect(where[Op.lt].toISOString()).toBe("2026-09-05T18:00:00.000Z");
  });

  it("ignores malformed boundaries instead of producing invalid SQL dates", () => {
    expect(dateRangeWhere({ from: "not-a-date", to: "2026/09/05" })).toEqual(
      {},
    );
  });
});
