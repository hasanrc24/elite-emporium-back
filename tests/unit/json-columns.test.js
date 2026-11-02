import { describe, expect, it } from "vitest";
import { decodeJsonValue } from "../../src/db/models/shared.js";

describe("decodeJsonValue", () => {
  it("decodes serialized objects and arrays (MariaDB LONGTEXT JSON)", () => {
    expect(decodeJsonValue('{"size":"M"}')).toEqual({ size: "M" });
    expect(decodeJsonValue(' ["a","b"] ')).toEqual(["a", "b"]);
  });

  it("leaves decoded values and string scalars untouched", () => {
    const value = { size: "M" };
    expect(decodeJsonValue(value)).toBe(value);
    expect(decodeJsonValue(null)).toBeNull();
    expect(decodeJsonValue("123")).toBe("123");
    expect(decodeJsonValue("{not json")).toBe("{not json");
  });
});
