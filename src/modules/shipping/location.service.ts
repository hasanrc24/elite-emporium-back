import { BdLocation, ShippingMethod, ShippingZone } from "../../db/models.js";
import { AppError } from "../../lib/errors.js";

type LocationRow = {
  code: string;
  level: "division" | "district" | "thana";
  parentCode: string | null;
  nameEn: string;
  nameBn: string;
  zoneCode: string | null;
};

let cache: { rows: LocationRow[]; loadedAt: number } | null = null;
const cacheMs = 5 * 60 * 1000;

async function loadLocations(): Promise<LocationRow[]> {
  if (cache && Date.now() - cache.loadedAt < cacheMs) return cache.rows;
  const rows: RuntimeValue = await BdLocation.findAll({
    where: { active: true },
    attributes: ["code", "level", "parentCode", "nameEn", "nameBn", "zoneCode"],
    order: [["displayOrder", "ASC"]],
  });
  cache = {
    rows: rows.map((row: RuntimeValue) => row.get({ plain: true })),
    loadedAt: Date.now(),
  };
  return cache.rows;
}

/** Public hierarchy for checkout selectors (cacheable, no personal data). */
export async function listLocations() {
  const rows = await loadLocations();
  return rows.map((row) => ({
    code: row.code,
    level: row.level,
    parentCode: row.parentCode,
    name: { en: row.nameEn, bn: row.nameBn },
  }));
}

/**
 * Resolves a district or thana code into names for the address snapshot and
 * the delivery method suggested for it. Inactive zones fall back to the
 * nationwide "outside Dhaka" rate so the suggestion is always purchasable.
 */
export async function resolveLocation(code: string) {
  const rows = await loadLocations();
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const location = byCode.get(code);
  if (!location || location.level === "division")
    throw AppError.unprocessable(
      "INVALID_LOCATION",
      "Select your district and area.",
      { "address.locationCode": ["Select your district and area."] },
    );
  const district =
    location.level === "district"
      ? location
      : byCode.get(location.parentCode || "");
  const division = district ? byCode.get(district.parentCode || "") : null;
  const zoneCode = location.zoneCode || district?.zoneCode || "outside_dhaka";
  return {
    code: location.code,
    thana: location.level === "thana" ? location : null,
    district: district || null,
    division: division || null,
    suggestedDeliveryCode: await activeMethodForZone(zoneCode),
  };
}

async function activeMethodForZone(zoneCode: string): Promise<string | null> {
  for (const code of [zoneCode, "outside_dhaka"]) {
    const method: RuntimeValue = await ShippingMethod.findOne({
      where: { active: true },
      include: [
        {
          model: ShippingZone,
          as: "zone",
          where: { code, active: true },
          required: true,
        },
      ],
      order: [["displayOrder", "ASC"]],
      attributes: ["code"],
    });
    if (method) return method.code;
  }
  return null;
}
