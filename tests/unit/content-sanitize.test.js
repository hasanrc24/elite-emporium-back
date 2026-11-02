import { describe, expect, it } from "vitest";
import { sanitizeValue } from "../../src/modules/content/content.service.js";

describe("CMS value sanitization", () => {
  it("sanitizes localized HTML and body fields", () => {
    const result = sanitizeValue({
      html: {
        en: "<p>Hi</p><script>alert(1)</script>",
        bn: "<img src=x onerror=alert(1)>",
      },
      body: { en: "<b onclick=x>Bold</b>" },
    });
    expect(result.html.en).toBe("<p>Hi</p>");
    expect(result.html.bn).toBe("");
    expect(result.body.en).not.toMatch(/onclick|<b/);
  });

  it("rejects unsafe localized URLs", () => {
    expect(() =>
      sanitizeValue({ url: { en: "javascript:alert(1)" } }),
    ).toThrow();
    expect(() =>
      sanitizeValue({ cta: { href: { bn: "//evil.test" } } }),
    ).toThrow();
    expect(sanitizeValue({ url: { en: "/shop" } })).toEqual({
      url: { en: "/shop" },
    });
  });
});
