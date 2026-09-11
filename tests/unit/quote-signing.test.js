import { describe, expect, it } from "vitest";
import { signPayload, verifyPayload } from "../../src/lib/crypto.js";

describe("signed checkout quotes", () => {
  it("round trips an untampered payload", () => {
    const token = signPayload({
      cartId: "01ABC",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(verifyPayload(token)).toEqual({
      cartId: "01ABC",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });
  it("rejects a modified token", () => {
    const token = signPayload({ cartId: "01ABC" });
    expect(verifyPayload(`${token.slice(0, -1)}x`)).toBeNull();
  });
});
