import { money } from "../../lib/money.js";

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const STOCK_POLICIES = ["deny", "allow_backorder", "preorder", "available"];

export const EXPORT_COLUMNS = [
  "product_id",
  "product_slug",
  "product_status",
  "name_en",
  "name_bn",
  "variant_id",
  "sku",
  "barcode",
  "variant_title",
  "regular_price",
  "sale_price",
  "sale_starts_at",
  "sale_ends_at",
  "stock_policy",
  "on_hand",
  "reserved",
  "low_stock_threshold",
  "variant_status",
] as const;

/** Parses RFC 4180 CSV (quoted cells, doubled quotes, CRLF, optional BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

/** Serializes rows; cells that a spreadsheet could run as a formula are neutralized. */
export function toCsv(rows: unknown[][]): string {
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if ("=+-@\t\r".includes(text.charAt(0)) && text) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return `${rows.map((row) => row.map(cell).join(",")).join("\n")}\n`;
}

export interface ImportChanges {
  barcode?: string | null;
  regularPrice?: string;
  salePrice?: string | null;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
  costPrice?: string | null;
  stockPolicy?: string;
  onHand?: number;
  lowStockThreshold?: number | null;
}

const instant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));

/**
 * Validates one import row. Empty cells leave a field unchanged; `none`
 * clears sale price/dates, cost and barcode, `inherit` clears the threshold.
 */
export function parseImportRow(raw: Record<string, string>): {
  changes: ImportChanges;
  errors: Record<string, string>;
} {
  const changes: ImportChanges = {};
  const errors: Record<string, string> = {};
  const get = (key: string) => (raw[key] ?? "").trim();
  const priceField = (
    key: string,
    target: "regularPrice" | "salePrice" | "costPrice",
  ) => {
    const value = get(key);
    if (!value) return;
    if (value.toLowerCase() === "none" && target !== "regularPrice") {
      changes[target] = null;
      return;
    }
    if (!MONEY.test(value))
      errors[key] = "Use a plain amount such as 1200 or 1200.50.";
    else changes[target] = money(value).toFixed(2);
  };
  priceField("regular_price", "regularPrice");
  priceField("sale_price", "salePrice");
  priceField("cost_price", "costPrice");
  for (const [key, target] of [
    ["sale_starts_at", "saleStartsAt"],
    ["sale_ends_at", "saleEndsAt"],
  ] as const) {
    const value = get(key);
    if (!value) continue;
    if (value.toLowerCase() === "none") changes[target] = null;
    else if (!instant(value))
      errors[key] = "Use a UTC time like 2027-03-01T00:00:00Z.";
    else changes[target] = new Date(value).toISOString();
  }
  const barcode = get("barcode");
  if (barcode)
    if (barcode.toLowerCase() === "none") changes.barcode = null;
    else if (barcode.length > 100) errors.barcode = "Barcode is too long.";
    else changes.barcode = barcode;
  const policy = get("stock_policy");
  if (policy)
    if (!STOCK_POLICIES.includes(policy))
      errors.stock_policy = `Use one of ${STOCK_POLICIES.join(", ")}.`;
    else changes.stockPolicy = policy;
  const onHand = get("on_hand");
  if (onHand)
    if (!/^\d{1,7}$/.test(onHand))
      errors.on_hand = "Use a whole number of 0 or more.";
    else changes.onHand = Number(onHand);
  const threshold = get("low_stock_threshold");
  if (threshold)
    if (threshold.toLowerCase() === "inherit") changes.lowStockThreshold = null;
    else if (!/^\d{1,7}$/.test(threshold))
      errors.low_stock_threshold = "Use a whole number or inherit.";
    else changes.lowStockThreshold = Number(threshold);
  return { changes, errors };
}

/** Cross-field rules, checked against the variant as it will be after the import. */
export function mergedVariantErrors(
  current: {
    regularPrice: string;
    salePrice: string | null;
    saleStartsAt: Date | string | null;
    saleEndsAt: Date | string | null;
    stockPolicy: string;
    preorderAvailableAt: Date | string | null;
  },
  changes: ImportChanges,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const regular = changes.regularPrice ?? current.regularPrice;
  const sale = "salePrice" in changes ? changes.salePrice : current.salePrice;
  const starts =
    "saleStartsAt" in changes ? changes.saleStartsAt : current.saleStartsAt;
  const ends =
    "saleEndsAt" in changes ? changes.saleEndsAt : current.saleEndsAt;
  if (money(regular).lessThanOrEqualTo(0))
    errors.regular_price = "Regular price must be above zero.";
  if (sale != null && money(sale).greaterThanOrEqualTo(money(regular)))
    errors.sale_price = "Sale price must be lower than the regular price.";
  if (starts && ends && new Date(starts) >= new Date(ends))
    errors.sale_ends_at = "Sale end must be after sale start.";
  if (
    (changes.stockPolicy ?? current.stockPolicy) === "preorder" &&
    !current.preorderAvailableAt
  )
    errors.stock_policy =
      "Set a preorder availability date in the product editor first.";
  return errors;
}
