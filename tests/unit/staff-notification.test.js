import { describe, expect, it } from "vitest";
import {
  crossedLowStock,
  parseStaffRecipient,
  staffNotificationContent,
} from "../../src/modules/notifications/staff-notification.rules.js";

const ulid = "01J0000000000000000000000A";

describe("staff notification recipients", () => {
  it("maps a staff audience to its permission", () =>
    expect(parseStaffRecipient("staff:orders")).toEqual({
      userId: null,
      permission: "orders.view",
    }));
  it("addresses one staff member with an optional permission", () =>
    expect(
      parseStaffRecipient(`user:${ulid}`, { permission: "reports.view" }),
    ).toEqual({ userId: ulid, permission: "reports.view" }));
  it("rejects unknown audiences and malformed ids", () => {
    expect(parseStaffRecipient("staff:everyone")).toBeNull();
    expect(parseStaffRecipient("staff:constructor")).toBeNull();
    expect(parseStaffRecipient("user:not-a-ulid")).toBeNull();
    expect(parseStaffRecipient("customer@example.com")).toBeNull();
  });
});

describe("staff notification content", () => {
  it("prefers the rendered template and keeps a safe admin link", () =>
    expect(
      staffNotificationContent(
        "order.placed",
        { subject: "New order EE-1", body: "Rahim · ৳1850.00" },
        { link: "/admin/orders/1", severity: "warning", dedupeKey: "k" },
      ),
    ).toEqual({
      title: "New order EE-1",
      body: "Rahim · ৳1850.00",
      link: "/admin/orders/1",
      severity: "warning",
      category: "order",
      dedupeKey: "k",
    }));
  it("falls back to the payload title and drops a body that repeats it", () => {
    const content = staffNotificationContent(
      "contact.received",
      { subject: null, body: "Hello" },
      { title: "Hello" },
    );
    expect(content.title).toBe("Hello");
    expect(content.body).toBeNull();
    expect(content.severity).toBe("info");
  });
  it("humanizes the event when nothing else names the alert", () =>
    expect(
      staffNotificationContent("inventory.low_stock", { body: "x" }).title,
    ).toBe("Inventory low stock"));
  it.each([
    "https://evil.example/admin",
    "//evil.example",
    "/admin//evil.example",
    "/administrator",
    "/admin\\..\\x",
    "/admin/orders\n",
    "javascript:alert(1)",
  ])("never stores an unsafe link: %s", (link) =>
    expect(staffNotificationContent("x.y", {}, { link }).link).toBeNull(),
  );
  it("accepts admin paths with a query", () =>
    expect(
      staffNotificationContent("x.y", {}, { link: "/admin/inventory?search=A" })
        .link,
    ).toBe("/admin/inventory?search=A"));
  it("rejects an unknown severity", () =>
    expect(
      staffNotificationContent("x.y", {}, { severity: "panic" }).severity,
    ).toBe("info"));
});

describe("low-stock crossing", () => {
  it("alerts only when stock falls to the threshold", () => {
    expect(crossedLowStock(6, 5, 5)).toBe(true);
    expect(crossedLowStock(10, 0, 5)).toBe(true);
    expect(crossedLowStock(5, 4, 5)).toBe(false);
    expect(crossedLowStock(10, 6, 5)).toBe(false);
  });
});
