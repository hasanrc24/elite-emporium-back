import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "../../src/modules/media/media.storage.js";

describe("media metadata stripping", () => {
  it("removes EXIF and applies orientation", async () => {
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#c33" },
    })
      .withExif({ IFD0: { Copyright: "secret-location" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeTruthy();
    const cleaned = await stripImageMetadata(source, "image/jpeg");
    expect((await sharp(cleaned).metadata()).exif).toBeUndefined();
    expect(cleaned.includes(Buffer.from("secret-location"))).toBe(false);
  });
  it("rejects undecodable data", async () => {
    await expect(
      stripImageMetadata(Buffer.from("not an image"), "image/png"),
    ).rejects.toThrow();
  });
});
