import { Op } from "sequelize";
import {
  IdempotencyRecord,
  InventoryLevel,
  InventoryMovement,
  Product,
  ProductTranslation,
  ProductVariant,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { resolveLowStockThreshold } from "../inventory/low-stock.js";
import { globalLowStockThreshold } from "./admin-product.service.js";
import {
  EXPORT_COLUMNS,
  mergedVariantErrors,
  parseCsv,
  parseImportRow,
  toCsv,
} from "./product-csv.js";
import type { ImportChanges } from "./product-csv.js";

const MAX_IMPORT_ROWS = 2000;
const MAX_EXPORT_PRODUCTS = 20_000;
const IMPORT_COLUMNS = new Set([
  "sku",
  "barcode",
  "regular_price",
  "sale_price",
  "sale_starts_at",
  "sale_ends_at",
  "cost_price",
  "stock_policy",
  "on_hand",
  "low_stock_threshold",
]);

interface CsvAccess {
  cost: boolean;
  publish: boolean;
}

/** One row per variant: pricing, sale schedule, stock policy and on-hand stock. */
export async function exportProductsCsv(
  query: RuntimeValue,
  access: CsvAccess,
) {
  const where: RuntimeValue = {};
  if (query.status === "archived") where.deletedAt = { [Op.ne]: null };
  else if (query.status) where.status = query.status;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.brandId) where.brandId = query.brandId;
  const products: RuntimeValue = await Product.findAll({
    where,
    paranoid: false,
    limit: MAX_EXPORT_PRODUCTS,
    order: [["slug", "ASC"]],
    include: [
      { model: ProductTranslation, as: "translations" },
      {
        model: ProductVariant,
        as: "variants",
        paranoid: false,
        required: false,
        include: [{ model: InventoryLevel, as: "inventoryLevels" }],
      },
    ],
  });
  const header: string[] = [...EXPORT_COLUMNS];
  if (access.cost) header.splice(13, 0, "cost_price");
  const rows: unknown[][] = [header];
  const iso = (value: RuntimeValue) =>
    value ? new Date(value).toISOString() : "";
  for (const product of products) {
    const name = (locale: string) =>
      product.translations.find((row: RuntimeValue) => row.locale === locale)
        ?.name || "";
    const variants = [...product.variants].sort(
      (left: RuntimeValue, right: RuntimeValue) =>
        String(left.sku).localeCompare(String(right.sku)),
    );
    for (const variant of variants) {
      const levels = variant.inventoryLevels || [];
      const sum = (key: string) =>
        levels.reduce(
          (total: number, level: RuntimeValue) => total + Number(level[key]),
          0,
        );
      const cells: Record<string, unknown> = {
        product_id: product.id,
        product_slug: product.slug,
        product_status: product.deletedAt ? "archived" : product.status,
        name_en: name("en"),
        name_bn: name("bn"),
        variant_id: variant.id,
        sku: variant.sku,
        barcode: variant.barcode || "",
        variant_title: variant.title,
        regular_price: moneyString(variant.regularPrice),
        sale_price:
          variant.salePrice == null ? "" : moneyString(variant.salePrice),
        sale_starts_at: iso(variant.saleStartsAt),
        sale_ends_at: iso(variant.saleEndsAt),
        cost_price:
          variant.costPrice == null ? "" : moneyString(variant.costPrice),
        stock_policy: variant.stockPolicy,
        on_hand: sum("onHand"),
        reserved: sum("reserved"),
        low_stock_threshold: variant.lowStockThreshold ?? "",
        variant_status: variant.status,
      };
      rows.push(header.map((column) => cells[column]));
    }
  }
  return toCsv(rows);
}

interface PlannedUpdate {
  row: number;
  sku: string;
  variantId: string;
  variantVersion: number;
  productId: string;
  changes: ImportChanges;
}
interface RowError {
  row: number;
  sku: string;
  field: string;
  message: string;
}

async function planImport(
  csv: string,
  access: CsvAccess,
  transaction: RuntimeValue,
) {
  const table = parseCsv(csv);
  if (table.length < 2)
    throw AppError.unprocessable("CSV_EMPTY", "The CSV has no data rows.", {
      csv: ["Provide a header row and at least one data row."],
    });
  const header = table[0].map((name) => name.trim().toLowerCase());
  const unknown = header.filter((name) => !IMPORT_COLUMNS.has(name));
  if (!header.includes("sku") || unknown.length)
    throw AppError.unprocessable(
      "CSV_INVALID_HEADER",
      "The CSV header is not recognized.",
      {
        csv: [
          !header.includes("sku")
            ? "A sku column is required."
            : `Unknown columns: ${unknown.join(", ")}.`,
        ],
      },
    );
  if (header.includes("cost_price") && !access.cost)
    throw AppError.forbidden(
      "Importing cost prices requires the catalog.cost permission.",
    );
  if (table.length - 1 > MAX_IMPORT_ROWS)
    throw AppError.unprocessable(
      "CSV_TOO_LARGE",
      `Import at most ${MAX_IMPORT_ROWS} rows at a time.`,
      { csv: [`The file has ${table.length - 1} rows.`] },
    );
  const errors: RowError[] = [];
  const parsed: Array<{ row: number; sku: string; changes: ImportChanges }> =
    [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const raw = Object.fromEntries(
      header.map((name, column) => [name, cells[column] ?? ""]),
    );
    const sku = (raw.sku || "").trim();
    const fail = (field: string, message: string) =>
      errors.push({ row, sku, field, message });
    if (!sku) return fail("sku", "SKU is required.");
    if (seen.has(sku.toLowerCase())) return fail("sku", "SKU appears twice.");
    seen.add(sku.toLowerCase());
    const result = parseImportRow(raw);
    for (const [field, message] of Object.entries(result.errors))
      fail(field, message);
    parsed.push({ row, sku, changes: result.changes });
  });
  const variants: RuntimeValue = await ProductVariant.findAll({
    where: { sku: { [Op.in]: parsed.map((item) => item.sku) } },
    paranoid: false,
    include: [{ model: Product, as: "product", paranoid: false }],
    transaction,
  });
  const bySku = new Map<string, RuntimeValue>(
    variants.map((variant: RuntimeValue) => [
      String(variant.sku).toLowerCase(),
      variant,
    ]),
  );
  const barcodes = parsed
    .map((item) => item.changes.barcode)
    .filter((value): value is string => Boolean(value));
  const barcodeOwners: RuntimeValue = barcodes.length
    ? await ProductVariant.findAll({
        where: { barcode: { [Op.in]: barcodes } },
        paranoid: false,
        attributes: ["id", "barcode"],
        transaction,
      })
    : [];
  const updates: PlannedUpdate[] = [];
  for (const item of parsed) {
    const variant = bySku.get(item.sku.toLowerCase());
    const fail = (field: string, message: string) =>
      errors.push({ row: item.row, sku: item.sku, field, message });
    if (!variant) {
      fail("sku", "No variant has this SKU.");
      continue;
    }
    if (variant.product?.deletedAt || variant.status !== "active") {
      fail("sku", "This variant or its product is archived.");
      continue;
    }
    const owner = barcodeOwners.find(
      (row: RuntimeValue) =>
        String(row.barcode).toLowerCase() ===
          String(item.changes.barcode).toLowerCase() && row.id !== variant.id,
    );
    if (owner) fail("barcode", "This barcode belongs to another variant.");
    for (const [field, message] of Object.entries(
      mergedVariantErrors(
        {
          regularPrice: moneyString(variant.regularPrice),
          salePrice:
            variant.salePrice == null ? null : moneyString(variant.salePrice),
          saleStartsAt: variant.saleStartsAt,
          saleEndsAt: variant.saleEndsAt,
          stockPolicy: variant.stockPolicy,
          preorderAvailableAt: variant.preorderAvailableAt,
        },
        item.changes,
      ),
    ))
      fail(field, message);
    updates.push({
      row: item.row,
      sku: item.sku,
      variantId: variant.id,
      variantVersion: Number(variant.version),
      productId: variant.productId,
      changes: item.changes,
    });
  }
  return { updates, errors, rows: parsed.length };
}

/**
 * Updates existing variants by SKU (price, sale schedule, cost, barcode, stock
 * policy, on-hand stock, low-stock threshold). `dryRun` validates only. A real
 * run is all-or-nothing and needs an Idempotency-Key.
 */
export async function importProductsCsv(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue,
  access: CsvAccess,
) {
  if (payload.dryRun) {
    const plan = await planImport(payload.csv, access, null);
    return {
      dryRun: true,
      rows: plan.rows,
      valid: plan.errors.length === 0,
      updates: plan.updates.map(({ row, sku, changes }) => ({
        row,
        sku,
        changes,
      })),
      errors: plan.errors.slice(0, 200),
    };
  }
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  const requestHash = sha256(canonicalJson({ csv: payload.csv }));
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const [record]: RuntimeValue = await IdempotencyRecord.findOrCreate({
      where: {
        scope: "catalog.import",
        key: idempotencyKey,
        actorKey: actorId,
      },
      defaults: {
        id: newId(),
        scope: "catalog.import",
        key: idempotencyKey,
        actorKey: actorId,
        requestHash,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
      transaction,
    });
    await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (record.requestHash !== requestHash)
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This import key was already used for a different file.",
      );
    if (record.responseBody) return record.responseBody;
    const plan = await planImport(payload.csv, access, transaction);
    if (plan.errors.length)
      throw AppError.unprocessable(
        "CSV_IMPORT_INVALID",
        "Fix the listed rows and try again. Nothing was imported.",
        Object.fromEntries(
          plan.errors
            .slice(0, 50)
            .map((error) => [
              `row.${error.row}.${error.field}`,
              [error.message],
            ]),
        ),
      );
    const productIds = [
      ...new Set(plan.updates.map((item) => item.productId)),
    ].sort();
    const products: RuntimeValue = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const variants: RuntimeValue = await ProductVariant.findAll({
      where: { id: { [Op.in]: plan.updates.map((item) => item.variantId) } },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const variantById = new Map<string, RuntimeValue>(
      variants.map((variant: RuntimeValue) => [variant.id, variant]),
    );
    const productById = new Map<string, RuntimeValue>(
      products.map((product: RuntimeValue) => [product.id, product]),
    );
    const globalThreshold = await globalLowStockThreshold(transaction);
    for (const item of plan.updates) {
      const variant = variantById.get(item.variantId);
      const product = productById.get(item.productId);
      if (
        !variant ||
        !product ||
        Number(variant.version) !== item.variantVersion
      )
        throw AppError.conflict(
          "VERSION_CONFLICT",
          `Variant ${item.sku} changed while importing. Run the import again.`,
        );
      const { onHand, lowStockThreshold, ...fields } = item.changes;
      const values: RuntimeValue = { ...fields, version: variant.version + 1 };
      if (lowStockThreshold !== undefined)
        values.lowStockThreshold = lowStockThreshold;
      await variant.update(values, { transaction });
      const levels: RuntimeValue = await InventoryLevel.findAll({
        where: { variantId: variant.id },
        order: [["id", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const resolved = resolveLowStockThreshold({
        variant: variant.lowStockThreshold,
        product: product.lowStockThreshold,
        global: globalThreshold,
      });
      for (const level of levels)
        if (Number(level.lowStockThreshold) !== resolved)
          await level.update({ lowStockThreshold: resolved }, { transaction });
      if (onHand !== undefined && levels[0]) {
        const level = levels[0];
        const delta = onHand - Number(level.onHand);
        if (delta !== 0) {
          const before = Number(level.onHand);
          await level.update(
            { onHand, version: Number(level.version) + 1 },
            { transaction },
          );
          await InventoryMovement.create(
            {
              id: newId(),
              variantId: variant.id,
              locationId: level.locationId,
              actorId,
              quantityDelta: delta,
              reservedDelta: 0,
              onHandBefore: before,
              balanceAfter: onHand,
              reservedAfter: Number(level.reserved),
              reason: "stock_count",
              note: "CSV import",
              correlationId: idempotencyKey,
            },
            { transaction },
          );
        }
      }
    }
    for (const product of products) {
      product.version += 1;
      await product.save({ transaction });
      await addDomainEvent({
        topic: "catalog.product_updated",
        aggregateType: "product",
        aggregateId: product.id,
        payload: {
          productId: product.id,
          slug: product.slug,
          version: product.version,
        },
        transaction,
      });
    }
    const response = {
      dryRun: false,
      rows: plan.rows,
      valid: true,
      updated: plan.updates.length,
      updates: [],
      errors: [],
    };
    record.responseStatus = 200;
    record.responseBody = response;
    await record.save({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.product_csv_import",
      resourceType: "products",
      metadata: {
        idempotencyKey,
        updated: plan.updates.length,
        skus: plan.updates.map((item) => item.sku),
      },
      request,
      transaction,
    });
    return response;
  });
}
