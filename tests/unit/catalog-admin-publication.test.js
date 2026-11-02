import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  publicationErrors,
} from "../../src/modules/catalog/publication.js";
import { combinationSignature } from "../../src/modules/catalog/product.schemas.js";

const ok = () => ({
  status: "published",
  slug: "rose-dress",
  categoryId: "c".repeat(26),
  names: { en: "Rose Dress", bn: "রোজ ড্রেস" },
  variants: [
    { status: "active", regularPrice: "1200.00", stockPolicy: "deny" },
  ],
  primaryImageCount: 1,
  imageCount: 4,
  minImages: 4,
  requiresSizeChart: false,
  sizeChartCount: 0,
});

describe("publication requirements", () => {
  it("accepts a complete product", () => {
    expect(publicationErrors(ok())).toBeNull();
  });

  it("does not validate drafts", () => {
    expect(
      publicationErrors({ ...ok(), status: "draft", variants: [] }),
    ).toBeNull();
  });

  it("blocks a product with no active purchasable variant", () => {
    expect(
      publicationErrors({
        ...ok(),
        variants: [{ status: "archived", regularPrice: "10" }],
      }).variants,
    ).toBeTruthy();
    expect(
      publicationErrors({
        ...ok(),
        variants: [{ status: "active", regularPrice: "0.00" }],
      }).variants,
    ).toBeTruthy();
  });

  it("requires both names, category, primary image and minimum images", () => {
    const errors = publicationErrors({
      ...ok(),
      names: { en: "x", bn: " " },
      categoryId: null,
      primaryImageCount: 0,
      imageCount: 2,
    });
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(["translations.bn.name", "categoryId", "media"]),
    );
  });

  it("requires a size chart only for size variations", () => {
    expect(
      publicationErrors({ ...ok(), requiresSizeChart: true }).sizeChartIds,
    ).toBeTruthy();
    expect(
      publicationErrors({
        ...ok(),
        requiresSizeChart: true,
        sizeChartCount: 1,
      }),
    ).toBeNull();
  });

  it("requires a preorder date and a valid stock policy", () => {
    const variants = [
      { status: "active", regularPrice: "5", stockPolicy: "preorder" },
    ];
    expect(publicationErrors({ ...ok(), variants }).variants).toBeTruthy();
    const bad = [{ status: "active", regularPrice: "5", stockPolicy: "wild" }];
    expect(publicationErrors({ ...ok(), variants: bad }).variants).toBeTruthy();
  });

  it("needs a future time for scheduled products", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    const scheduled = { ...ok(), status: "scheduled" };
    expect(
      publicationErrors(
        { ...scheduled, publishAt: "2026-12-31T00:00:00Z" },
        now,
      ).publishAt,
    ).toBeTruthy();
    expect(
      publicationErrors(
        { ...scheduled, publishAt: "2027-02-01T00:00:00Z" },
        now,
      ),
    ).toBeNull();
    try {
      assertPublishable({ ...scheduled, publishAt: null }, now);
    } catch (error) {
      expect(error.code).toBe("INVALID_PUBLISH_SCHEDULE");
    }
  });

  it("throws PUBLISH_REQUIREMENTS with field errors", () => {
    try {
      assertPublishable({ ...ok(), categoryId: null });
      throw new Error("expected failure");
    } catch (error) {
      expect(error.code).toBe("PUBLISH_REQUIREMENTS");
      expect(error.fieldErrors.categoryId).toBeTruthy();
    }
  });
});

describe("combinationSignature", () => {
  it("is order independent and ignores blanks", () => {
    expect(combinationSignature({ size: "M", color: "red", fabric: " " })).toBe(
      "color:red|size:M",
    );
    expect(combinationSignature(null)).toBe("");
  });
});
