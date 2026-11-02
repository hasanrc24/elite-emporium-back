import { describe, expect, it } from "vitest";
import { generateMethodCode } from "../../src/modules/shipping/method-code.js";

describe("generateMethodCode", () => {
  const valid = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
  it("builds a readable, valid code", () => {
    expect(generateMethodCode("Express Delivery (Dhaka)", "AB12cd")).toBe(
      "express_delivery_dhaka_ab12cd",
    );
  });
  it("falls back when the name has no Latin letters", () => {
    const code = generateMethodCode("দ্রুত ডেলিভারি", "x9y8z7");
    expect(code).toBe("delivery_x9y8z7");
    expect(code).toMatch(valid);
  });
  it("stays within the 60 character limit", () => {
    const code = generateMethodCode("a".repeat(200), "123456");
    expect(code.length).toBeLessThanOrEqual(60);
    expect(code).toMatch(valid);
  });
});
