import { describe, expect, it } from "vitest";
import { ipPrefix } from "../../src/lib/ip-prefix.js";

describe("ipPrefix", () => {
  it("collapses IPv4 to /24", () => {
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
  });
  it("collapses IPv6 to /64", () => {
    expect(ipPrefix("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });
  it("returns null for empty input", () => {
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix(undefined)).toBeNull();
  });
});
