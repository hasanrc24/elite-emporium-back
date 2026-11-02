import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCustomData,
  buildEvent,
  buildUserData,
  classifyResponse,
  hashPhone,
  hashValue,
  isFbc,
  isFbp,
  isPixelId,
  retryDelaySeconds,
  safeSourceUrl,
} from "../../src/modules/tracking/meta-capi.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

describe("meta capi hashing", () => {
  it("normalizes email before hashing", () => {
    expect(hashValue("  Test@Example.COM ")).toBe(sha("test@example.com"));
    expect(hashValue("  ")).toBeNull();
  });
  it("hashes Bangladeshi phones with the 880 country code", () => {
    expect(hashPhone("01712345678")).toBe(sha("8801712345678"));
    expect(hashPhone("+8801712345678")).toBe(sha("8801712345678"));
    expect(hashPhone("12345")).toBeNull();
  });
  it("never leaves raw identifiers in user_data", () => {
    const data = buildUserData({
      email: "a@b.co",
      phone: "+8801712345678",
      name: "Rahim Uddin",
      city: "Dhaka",
      externalId: "user1",
      ip: "203.0.113.5",
      userAgent: "UA",
      fbp: "fb.1.1700000000000.123456789",
      fbc: "not-valid",
    });
    expect(JSON.stringify(data)).not.toContain("a@b.co");
    expect(JSON.stringify(data)).not.toContain("8801712345678");
    expect(data.em).toEqual([sha("a@b.co")]);
    expect(data.fn).toEqual([sha("rahim")]);
    expect(data.ln).toEqual([sha("uddin")]);
    expect(data.country).toEqual([sha("bd")]);
    expect(data.client_ip_address).toBe("203.0.113.5");
    expect(data.fbp).toBe("fb.1.1700000000000.123456789");
    expect(data.fbc).toBeUndefined();
  });
});

describe("meta capi event shaping", () => {
  it("validates cookie formats and pixel ids", () => {
    expect(isFbp("fb.1.1700000000000.123456789")).toBe(true);
    expect(isFbc("fb.1.1700000000000.AbCdEf_123")).toBe(true);
    expect(isFbp("garbage")).toBe(false);
    expect(isPixelId("123456789012345")).toBe(true);
    expect(isPixelId("abc")).toBe(false);
  });
  it("builds custom data with contents", () => {
    const data = buildCustomData({
      value: "1250.50",
      contents: [{ id: "p1", quantity: 2, price: "625.25" }],
    });
    expect(data).toMatchObject({
      value: 1250.5,
      currency: "BDT",
      content_ids: ["p1"],
      content_type: "product",
      num_items: 2,
    });
  });
  it("builds an event with second-resolution time", () => {
    const event = buildEvent({
      name: "Purchase",
      eventId: "purchase_X",
      eventTime: new Date("2026-01-01T00:00:00.900Z"),
      userData: {},
      customData: {},
    });
    expect(event.event_time).toBe(1767225600);
    expect(event.action_source).toBe("website");
  });
  it("keeps only same-origin source URLs and strips the query", () => {
    expect(
      safeSourceUrl("https://shop.test/en/p/x?token=1#a", "https://shop.test"),
    ).toBe("https://shop.test/en/p/x");
    expect(
      safeSourceUrl("https://evil.test/x", "https://shop.test"),
    ).toBeNull();
    expect(
      safeSourceUrl("javascript:alert(1)", "https://shop.test"),
    ).toBeNull();
  });
});

describe("meta capi delivery policy", () => {
  it("classifies responses", () => {
    expect(classifyResponse(200, {})).toBe("sent");
    expect(classifyResponse(500, null)).toBe("retry");
    expect(classifyResponse(429, null)).toBe("retry");
    expect(classifyResponse(400, { error: { code: 100 } })).toBe("failed");
    expect(classifyResponse(400, { error: { code: 190 } })).toBe("failed");
    expect(classifyResponse(400, { error: { code: 613 } })).toBe("retry");
  });
  it("backs off exponentially up to an hour", () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});
