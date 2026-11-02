import { describe, expect, it } from "vitest";
import {
  expandWithSynonyms,
  normalizeSearchTerm,
  typoCorrections,
} from "../../src/modules/catalog/search.service.js";
import {
  attributeFilters,
  publicFashion,
} from "../../src/modules/catalog/catalog.service.js";
import { bdLocationSeeds } from "../../src/db/data/bd-locations.js";

describe("search normalization", () => {
  it("folds case, separators and Bangla digits", () => {
    expect(normalizeSearchTerm("  Three-Piece  ৩ ")).toBe("three piece 3");
  });

  it("expands Banglish and Bangla spellings through synonym sets", () => {
    const sets = [{ term: "salwar", synonyms: ["shalwar", "সালোয়ার"] }];
    expect(expandWithSynonyms("Shalwar", sets)).toEqual([
      "shalwar",
      "salwar",
      "সালোয়ার",
    ]);
    expect(expandWithSynonyms("kurti", sets)).toEqual(["kurti"]);
    expect(expandWithSynonyms("red shalwar", sets)).toEqual([
      "red shalwar",
      "red salwar",
      "red সালোয়ার",
    ]);
  });
});

describe("attribute filters", () => {
  it("parses validated key/value lists", () => {
    expect(attributeFilters("size:M|L,color:Red")).toEqual([
      ["size", ["M", "L"]],
      ["color", ["Red"]],
    ]);
  });

  it("drops unsafe keys and empty values", () => {
    expect(attributeFilters("si'ze:M,color:,$.x:1")).toEqual([]);
    expect(attributeFilters(undefined)).toEqual([]);
  });
});

describe("public fashion details", () => {
  it("whitelists values and localizes text", () => {
    expect(
      publicFashion(
        {
          fitType: "loose",
          fitNote: "runs_small",
          stitched: false,
          pieces: { en: "Kameez, salwar, orna", bn: "কামিজ, সালোয়ার, ওড়না" },
          modelHeightCm: 165,
          modelSize: "M",
          injected: "<script>",
        },
        "bn",
      ),
    ).toEqual({
      fitType: "loose",
      fitNote: "runs_small",
      stitched: false,
      pieces: "কামিজ, সালোয়ার, ওড়না",
      occasion: "",
      origin: "",
      modelHeightCm: 165,
      modelSize: "M",
    });
  });

  it("rejects unknown enums and out-of-range numbers", () => {
    expect(
      publicFashion({ fitType: "tight", modelHeightCm: 400 }, "en"),
    ).toMatchObject({ fitType: null, modelHeightCm: null });
    expect(publicFashion(null, "en")).toBeNull();
  });
});

describe("Bangladesh locations", () => {
  const rows = bdLocationSeeds();

  it("seeds all 8 divisions and 64 districts with unique codes", () => {
    expect(rows.filter((row) => row.level === "division")).toHaveLength(8);
    expect(rows.filter((row) => row.level === "district")).toHaveLength(64);
    expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
  });

  it("maps Dhaka city, suburbs and the rest of the country to zones", () => {
    const zone = (code) => rows.find((row) => row.code === code)?.zoneCode;
    expect(zone("thana-dhaka-dhanmondi")).toBe("inside_dhaka");
    expect(zone("thana-dhaka-savar")).toBe("dhaka_suburb");
    expect(zone("dist-gazipur")).toBe("dhaka_suburb");
    expect(zone("dist-sylhet")).toBe("outside_dhaka");
  });

  it("links every non-division row to an existing parent", () => {
    const codes = new Set(rows.map((row) => row.code));
    for (const row of rows.filter((item) => item.level !== "division"))
      expect(codes.has(row.parentCode)).toBe(true);
  });
});

describe("search typo tolerance", () => {
  const vocabulary = new Set(["kameez", "salwar", "saree", "georgette"]);

  it("corrects one-character typos in words of 5+ characters", () => {
    expect(typoCorrections("red kamez", vocabulary)).toEqual(["red kameez"]);
    expect(typoCorrections("georgete saree", vocabulary)).toEqual([
      "georgette saree",
    ]);
    expect(typoCorrections("salwer", vocabulary)).toEqual(["salwar"]);
  });

  it("leaves known, short and distant words alone", () => {
    expect(typoCorrections("kameez", vocabulary)).toEqual([]);
    expect(typoCorrections("sare", vocabulary)).toEqual([]);
    expect(typoCorrections("kmz", vocabulary)).toEqual([]);
    expect(typoCorrections("panjabi", vocabulary)).toEqual([]);
  });
});
