import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../../src/modules/integrations/outbound.js";

describe("outbound address blocking", () => {
  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "febf::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "not-an-ip",
    ])
      expect(isBlockedAddress(address), address).toBe(true);
  });

  it("allows public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isBlockedAddress(address), address).toBe(false);
  });
});
