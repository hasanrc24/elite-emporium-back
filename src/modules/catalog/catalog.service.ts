import { literal, Op } from "sequelize";
import {
  Attribute,
  AttributeTranslation,
  AttributeValue,
  AttributeValueTranslation,
  Brand,
  BrandTranslation,
  Category,
  CategoryTranslation,
  Collection,
  CollectionTranslation,
  InventoryLevel,
  MediaAsset,
  Product,
  ProductMedia,
  ProductTranslation,
  ProductVariant,
  Redirect,
  Review,
  SizeChart,
  SizeChartRow,
  StockLocation,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { likeContains } from "../../lib/like.js";
import { moneyString } from "../../lib/money.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { mediaPublicUrl } from "../media/media.storage.js";
import { settingValue } from "../settings/settings.service.js";
import { effectivePrice, priceDto } from "./pricing.js";
import {
  normalizeSearchTerm,
  recordSearchMiss,
  searchTerms,
} from "./search.service.js";

/** Products published within this many days carry the "new" badge/filter. */
const NEW_PRODUCT_DAYS = 30;
const PUBLIC_VISIBILITY = ["catalog_search", "catalog"];

const localeName = (translations: RuntimeValue = [], locale: RuntimeValue) =>
  translations.find((item: RuntimeValue) => item.locale === locale) ||
  translations.find((item: RuntimeValue) => item.locale === "en") ||
  translations[0];
const translationInclude = (
  model: RuntimeValue,
  as: RuntimeValue = "translations",
) => ({ model, as });
const variantInclude: RuntimeValue = {
  model: ProductVariant,
  as: "variants",
  where: { status: "active", active: true },
  required: false,
  separate: true,
  order: [
    ["isDefault", "DESC"],
    ["createdAt", "ASC"],
  ],
  include: [
    {
      model: InventoryLevel,
      as: "inventoryLevels",
      include: [
        {
          model: StockLocation,
          as: "location",
          where: { active: true },
          required: false,
        },
      ],
    },
  ],
};
const mediaInclude: RuntimeValue = {
  model: ProductMedia,
  as: "media",
  separate: true,
  order: [["displayOrder", "ASC"]],
  include: [
    {
      model: MediaAsset,
      as: "asset",
      where: { status: "ready", privacy: "public" },
      required: true,
    },
  ],
};
const publicProductInclude: RuntimeValue = [
  translationInclude(ProductTranslation),
  variantInclude,
  mediaInclude,
  {
    model: Category,
    as: "category",
    include: [translationInclude(CategoryTranslation)],
  },
  {
    model: Brand,
    as: "brand",
    include: [translationInclude(BrandTranslation)],
  },
];

function imageDto(item: RuntimeValue, locale: RuntimeValue) {
  return {
    id: item.asset.id,
    role: item.role,
    variantId: item.variantId || null,
    url: mediaPublicUrl(item.asset.storageKey),
    // Derived files only (no storage keys); legacy rows without a format are WebP.
    variants: (item.asset.metadata?.variants || []).map(
      (variant: RuntimeValue) => ({
        width: variant.width,
        format: variant.format || "webp",
        url: variant.url,
      }),
    ),
    width: item.asset.width,
    height: item.asset.height,
    alt:
      (locale === "bn" ? item.altBn : item.altEn) || item.asset.altText || "",
  };
}

const imagePrimary = (images: RuntimeValue[]) =>
  images.find((item: RuntimeValue) => item.role === "primary") ||
  images[0] ||
  null;

function availabilityDto(variant: RuntimeValue, showExactStock = true) {
  // Levels at inactive stock locations are not sellable stock; the include
  // leaves `location` null for them.
  const levels = (
    variant.inventoryLevels || (variant.inventory ? [variant.inventory] : [])
  ).filter((level: RuntimeValue) => level.location !== null);
  const availableQuantity: RuntimeValue = levels.reduce(
    (total: RuntimeValue, level: RuntimeValue) =>
      total +
      Math.max(0, Number(level.onHand || 0) - Number(level.reserved || 0)),
    0,
  );
  const lowStockThreshold: RuntimeValue = levels.reduce(
    (total: RuntimeValue, level: RuntimeValue) =>
      total + Number(level.lowStockThreshold || 0),
    0,
  );
  return {
    available: variant.stockPolicy !== "deny" || availableQuantity > 0,
    // Hidden when the store setting turns exact stock off (null, not 0).
    availableQuantity: showExactStock ? availableQuantity : null,
    stockPolicy: variant.stockPolicy,
    lowStock: availableQuantity > 0 && availableQuantity <= lowStockThreshold,
    preorderAvailableAt: variant.preorderAvailableAt || null,
    preorderMessage: variant.preorderMessage || null,
  };
}

const fitTypes = new Set(["regular", "slim", "loose", "oversized"]);
const fitNotes = new Set(["runs_small", "true_to_size", "runs_large"]);

/** Whitelisted fashion details for the storefront (BE-CAT-004). */
export function publicFashion(raw: RuntimeValue, locale: RuntimeValue) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") return null;
  const text = (input: RuntimeValue) =>
    typeof input === "object" && input
      ? String(input[locale] || input.en || "").slice(0, 300)
      : "";
  return {
    fitType: fitTypes.has(value.fitType) ? value.fitType : null,
    fitNote: fitNotes.has(value.fitNote) ? value.fitNote : null,
    stitched: typeof value.stitched === "boolean" ? value.stitched : null,
    pieces: text(value.pieces),
    occasion: text(value.occasion),
    origin: text(value.origin),
    modelHeightCm:
      Number.isInteger(value.modelHeightCm) &&
      value.modelHeightCm >= 100 &&
      value.modelHeightCm <= 220
        ? value.modelHeightCm
        : null,
    modelSize:
      typeof value.modelSize === "string" ? value.modelSize.slice(0, 20) : null,
  };
}

/** Pure: converts size-chart cells (cm or in) into both units, 1dp. */
export function sizeChartCells(
  cells: RuntimeValue,
  units: RuntimeValue,
): { cm: Record<string, number>; inch: Record<string, number> } {
  const value = typeof cells === "string" ? JSON.parse(cells) : cells;
  const cm: Record<string, number> = {};
  const inch: Record<string, number> = {};
  const round = (input: number) => Math.round(input * 10) / 10;
  for (const [key, raw] of Object.entries(value || {})) {
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    cm[key] = round(units === "in" ? number * 2.54 : number);
    inch[key] = round(units === "in" ? number : number / 2.54);
  }
  return { cm, inch };
}

export function isNewProduct(publishedAt: RuntimeValue, at = new Date()) {
  if (!publishedAt) return false;
  const age = at.getTime() - new Date(publishedAt).getTime();
  return age >= 0 && age <= NEW_PRODUCT_DAYS * 86_400_000;
}

export function publicProduct(
  product: RuntimeValue,
  locale: RuntimeValue = "en",
  includeDetail: RuntimeValue = false,
  showExactStock = true,
) {
  const translation: RuntimeValue = localeName(product.translations, locale);
  const english: RuntimeValue = (product.translations || []).find(
    (item: RuntimeValue) => item.locale === "en",
  );
  // Optional translated fields fall back to English when blank (BE-DATA-002).
  const field = (name: string) => translation?.[name] || english?.[name] || "";
  const variants: RuntimeValue = (product.variants || []).map(
    (variant: RuntimeValue) => ({
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      attributes: variant.attributes,
      ...priceDto(variant),
      ...availabilityDto(variant, showExactStock),
      isDefault: variant.isDefault,
      weightGrams: variant.weightGrams,
      dimensions: variant.dimensions,
    }),
  );
  const prices: RuntimeValue = variants.map((variant: RuntimeValue) =>
    effectivePrice(variant),
  );
  const images: RuntimeValue = (product.media || []).map((item: RuntimeValue) =>
    imageDto(item, locale),
  );
  return {
    id: product.id,
    slug: product.slug,
    type: product.type,
    featured: product.featured,
    isNew: isNewProduct(product.publishedAt),
    onSale: variants.some((variant: RuntimeValue) => variant.onSale),
    available: variants.some((variant: RuntimeValue) => variant.available),
    name: field("name"),
    shortDescription: field("shortDescription"),
    ...(includeDetail
      ? {
          description: field("description"),
          careText: field("careText"),
          materialText: field("materialText"),
          fashion: publicFashion(product.fashion, locale),
          seo: {
            title: field("seoTitle") || field("name"),
            description: field("seoDescription") || field("shortDescription"),
            canonicalUrl: product.canonicalUrl || null,
            image: imagePrimary(images)?.url || null,
          },
        }
      : {}),
    category: product.category
      ? {
          id: product.category.id,
          slug: product.category.slug,
          name: localeName(product.category.translations, locale)?.name || "",
        }
      : null,
    brand: product.brand
      ? {
          id: product.brand.id,
          slug: product.brand.slug,
          name: localeName(product.brand.translations, locale)?.name || "",
        }
      : null,
    images,
    primaryImage: imagePrimary(images),
    variants,
    rating: {
      average: Number(product.reviewAverage || 0),
      count: Number(product.reviewCount || 0),
    },
    priceRange: prices.length
      ? {
          min: moneyString(
            prices.reduce((minimum: RuntimeValue, price: RuntimeValue) =>
              price.lessThan(minimum) ? price : minimum,
            ),
          ),
          max: moneyString(
            prices.reduce((maximum: RuntimeValue, price: RuntimeValue) =>
              price.greaterThan(maximum) ? price : maximum,
            ),
          ),
        }
      : null,
  };
}

function activeWindowWhere() {
  return {
    active: true,
    [Op.and]: [
      { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: new Date() } }] },
      { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: new Date() } }] },
    ],
  };
}

/**
 * Parses `attr=size:M|L,color:Red` into validated key/value lists. Keys are
 * attribute keys (slug-like); values are matched against variant attribute
 * values, so nothing from the query string reaches SQL unescaped.
 */
export function attributeFilters(raw: unknown): [string, string[]][] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const filters: [string, string[]][] = [];
  for (const part of raw.split(",").slice(0, 8)) {
    const [key, list = ""] = part.split(":");
    if (!/^[a-z0-9_-]{1,60}$/.test(key || "")) continue;
    const values = list
      .split("|")
      .map((value) => value.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 20);
    if (values.length) filters.push([key, values]);
  }
  return filters;
}

const salePriceSql =
  "(CASE WHEN pv.salePrice IS NOT NULL AND (pv.saleStartsAt IS NULL OR pv.saleStartsAt <= UTC_TIMESTAMP(3)) AND (pv.saleEndsAt IS NULL OR pv.saleEndsAt > UTC_TIMESTAMP(3)) AND pv.salePrice < pv.regularPrice THEN pv.salePrice ELSE pv.regularPrice END)";

/** Compact `a OR b` / `a AND b` joiner for hand-built SQL fragments. */
const sqlOr = (parts: string[]) => `(${parts.join(" OR ")})`;
const sqlAnd = (parts: string[]) => `(${parts.join(" AND ")})`;

function productFilterSql(query: RuntimeValue) {
  const clauses: RuntimeValue = [];
  const minimum: RuntimeValue = Number(query.minPrice);
  const maximum: RuntimeValue = Number(query.maxPrice);
  if (query.minPrice !== undefined && Number.isFinite(minimum) && minimum >= 0)
    clauses.push(`${salePriceSql} >= ${sequelize.escape(minimum.toFixed(2))}`);
  if (query.maxPrice !== undefined && Number.isFinite(maximum) && maximum >= 0)
    clauses.push(`${salePriceSql} <= ${sequelize.escape(maximum.toFixed(2))}`);
  if (query.sale === "true") clauses.push(`${salePriceSql} < pv.regularPrice`);
  if (query.available === "true")
    clauses.push("(pv.stockPolicy <> 'deny' OR (il.onHand - il.reserved) > 0)");
  for (const [key, values] of attributeFilters(query.attr))
    clauses.push(
      `JSON_UNQUOTE(JSON_EXTRACT(pv.attributes, ${sequelize.escape(`$."${key}"`)})) IN (${values.map((value) => sequelize.escape(value)).join(", ")})`,
    );
  if (!clauses.length) return null;
  // Only stock at active locations counts; soft-deleted variants never match.
  return literal(
    `EXISTS (SELECT 1 FROM product_variants pv LEFT JOIN inventory_levels il ON il.variantId = pv.id AND il.locationId IN (SELECT sl.id FROM stock_locations sl WHERE sl.active = 1) WHERE pv.productId = Product.id AND pv.deletedAt IS NULL AND pv.active = 1 AND pv.status = 'active' AND ${clauses.join(" AND ")})`,
  );
}

const priceSort: RuntimeValue = literal(
  `(SELECT MIN(${salePriceSql}) FROM product_variants pv WHERE pv.productId = Product.id AND pv.deletedAt IS NULL AND pv.active = 1 AND pv.status = 'active')`,
);
/** Units sold over the last 90 days by non-cancelled orders. */
const bestSellingSort: RuntimeValue = literal(
  "(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN product_variants v ON v.id = oi.variantId JOIN orders o ON o.id = oi.orderId WHERE v.productId = Product.id AND o.orderStatus NOT IN ('draft', 'cancelled', 'failed') AND o.createdAt >= (UTC_TIMESTAMP(3) - INTERVAL 90 DAY))",
);

/** One search word matching slug, any-locale name/description, category or SKU. */
function wordMatchSql(word: string) {
  const pattern = sequelize.escape(likeContains(word, 80));
  return sqlOr([
    `Product.slug LIKE ${pattern}`,
    `EXISTS (SELECT 1 FROM product_translations pt WHERE pt.productId = Product.id AND (pt.name LIKE ${pattern} OR pt.shortDescription LIKE ${pattern}))`,
    `EXISTS (SELECT 1 FROM category_translations ct WHERE ct.categoryId = Product.categoryId AND ct.name LIKE ${pattern})`,
    `EXISTS (SELECT 1 FROM product_variants sv WHERE sv.productId = Product.id AND sv.deletedAt IS NULL AND sv.sku LIKE ${pattern})`,
  ]);
}

/**
 * Pure-ish SQL builder: every word of a (synonym/typo-expanded) term must
 * match somewhere; any expanded term may match (BE-SEARCH-001).
 */
export function searchWhereSql(terms: string[]) {
  const alternatives = terms
    .slice(0, 8)
    .map((term) =>
      term
        .split(" ")
        .filter(Boolean)
        .slice(0, 5)
        .map((word) => wordMatchSql(word)),
    )
    .filter((words) => words.length)
    .map(sqlAnd);
  return alternatives.length ? literal(sqlOr(alternatives)) : null;
}

/** Ascending relevance: exact name, name prefix, name contains, other. */
function relevanceSort(term: string): RuntimeValue {
  const exact = sequelize.escape(term.replace(/[\\%_]/g, (c) => `\\${c}`));
  const contains = likeContains(term, 80);
  return literal(
    `(SELECT COALESCE(MIN(CASE WHEN pt.name LIKE ${exact} THEN 0 WHEN pt.name LIKE ${sequelize.escape(contains.slice(1))} THEN 1 WHEN pt.name LIKE ${sequelize.escape(contains)} THEN 2 ELSE 3 END), 4) FROM product_translations pt WHERE pt.productId = Product.id)`,
  );
}

/** The category and all its active descendants (small table, one query). */
async function categoryWithDescendants(rootId: string) {
  const rows: RuntimeValue = await Category.findAll({
    where: { active: true },
    attributes: ["id", "parentId"],
    raw: true,
  });
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows)
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
  }
  return [...ids];
}

const emptyPage = (page: number, pageSize: number) => ({
  data: [],
  meta: { page, pageSize, total: 0, pageCount: 0 },
});

/** Accepts only plain strings so `?brand[]=x` style arrays cannot widen filters. */
const textParam = (value: unknown) =>
  typeof value === "string" && value.length <= 180 ? value : undefined;

export async function listProducts(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const search = textParam(query.search)?.trim();
  const where: RuntimeValue = {
    status: "published",
    // Search results include search-only products; plain browsing includes
    // catalog-only products. Hidden products appear in neither.
    visibility: {
      [Op.in]: search ? ["catalog_search", "search"] : PUBLIC_VISIBILITY,
    },
  };
  const conditions: RuntimeValue[] = [];
  if (query.featured === "true") where.featured = true;
  if (query.new === "true")
    where.publishedAt = {
      [Op.gte]: new Date(Date.now() - NEW_PRODUCT_DAYS * 86_400_000),
    };
  if (typeof query.slugs === "string" && query.slugs) {
    // Recently viewed / curated lists: a bounded set of validated slugs.
    const slugs = query.slugs
      .split(",")
      .map((slug: string) => slug.trim())
      .filter((slug: string) => /^[a-z0-9-]{1,180}$/.test(slug))
      .slice(0, 24);
    where.slug = { [Op.in]: slugs.length ? slugs : ["-"] };
  }
  if (typeof query.ids === "string" && query.ids) {
    // Hand-picked homepage products: a bounded set of validated IDs.
    const ids = query.ids
      .split(",")
      .map((id: string) => id.trim())
      .filter((id: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
      .slice(0, 48);
    where.id = { [Op.in]: ids.length ? ids : ["-"] };
  }
  let relevance: RuntimeValue = null;
  if (search) {
    const normalized = normalizeSearchTerm(search);
    const terms: RuntimeValue = await searchTerms(search);
    const clause = searchWhereSql(terms);
    if (clause) conditions.push(clause);
    relevance = relevanceSort(normalized);
  }
  const brandSlug = textParam(query.brand);
  if (query.brand !== undefined) {
    const brand: RuntimeValue = brandSlug
      ? await Brand.findOne({
          where: { slug: brandSlug, active: true },
          attributes: ["id"],
        })
      : null;
    if (!brand) return emptyPage(page, pageSize);
    where.brandId = brand.id;
  }
  const categorySlug = textParam(query.category);
  if (query.category !== undefined) {
    const category: RuntimeValue = categorySlug
      ? await Category.findOne({
          where: { slug: categorySlug, active: true },
          attributes: ["id"],
        })
      : null;
    if (!category) return emptyPage(page, pageSize);
    const ids = (await categoryWithDescendants(category.id))
      .map((id) => sequelize.escape(id))
      .join(", ");
    conditions.push(
      literal(
        `(Product.categoryId IN (${ids}) OR EXISTS (SELECT 1 FROM product_categories pc WHERE pc.productId = Product.id AND pc.categoryId IN (${ids})))`,
      ),
    );
  }
  const collectionSlug = textParam(query.collection);
  if (query.collection !== undefined) {
    const collection: RuntimeValue = collectionSlug
      ? await Collection.findOne({
          where: { slug: collectionSlug, ...activeWindowWhere() },
          attributes: ["id"],
        })
      : null;
    if (!collection) return emptyPage(page, pageSize);
    conditions.push(
      literal(
        `EXISTS (SELECT 1 FROM product_collections pcl WHERE pcl.productId = Product.id AND pcl.collectionId = ${sequelize.escape(collection.id)})`,
      ),
    );
  }
  const occasion = textParam(query.occasion)?.trim();
  if (occasion) {
    const value = sequelize.escape(occasion.toLowerCase());
    conditions.push(
      literal(
        `(LOWER(JSON_UNQUOTE(JSON_EXTRACT(Product.fashion, '$.occasion.en'))) = ${value} OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(Product.fashion, '$.occasion.bn'))) = ${value})`,
      ),
    );
  }
  const fabric = textParam(query.fabric)?.trim();
  if (fabric)
    conditions.push(
      literal(
        `EXISTS (SELECT 1 FROM product_translations ft WHERE ft.productId = Product.id AND ft.materialText LIKE ${sequelize.escape(likeContains(fabric, 80))})`,
      ),
    );
  const variantFilter: RuntimeValue = productFilterSql(query);
  if (variantFilter) conditions.push(variantFilter);
  if (conditions.length) where[Op.and] = conditions;
  const stable: RuntimeValue = [["id", "ASC"]];
  const sort = textParam(query.sort);
  const order: RuntimeValue =
    sort === "price_asc"
      ? [[priceSort, "ASC"], ...stable]
      : sort === "price_desc"
        ? [[priceSort, "DESC"], ...stable]
        : sort === "rating" || sort === "top_rated"
          ? [["reviewAverage", "DESC"], ["reviewCount", "DESC"], ...stable]
          : sort === "bestselling" || sort === "best_selling"
            ? [[bestSellingSort, "DESC"], ["publishedAt", "DESC"], ...stable]
            : sort === "newest"
              ? [["publishedAt", "DESC"], ["createdAt", "DESC"], ...stable]
              : relevance && !sort
                ? [
                    [relevance, "ASC"],
                    ["reviewCount", "DESC"],
                    ["publishedAt", "DESC"],
                    ...stable,
                  ]
                : [
                    ["featured", "DESC"],
                    ["publishedAt", "DESC"],
                    ["createdAt", "DESC"],
                    ...stable,
                  ];
  const [result, inventory]: RuntimeValue = await Promise.all([
    Product.findAndCountAll({
      where,
      include: publicProductInclude,
      distinct: true,
      limit,
      offset,
      order,
    }),
    settingValue("inventory"),
  ]);
  if (search && !result.count) void recordSearchMiss(search, query.locale);
  return {
    data: result.rows.map((product: RuntimeValue) =>
      publicProduct(
        product,
        query.locale,
        false,
        inventory?.showExactStock !== false,
      ),
    ),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

async function categoryTrail(categoryId: string | null, locale: RuntimeValue) {
  const trail: RuntimeValue[] = [];
  let currentId = categoryId;
  // Bounded walk: a bad parent cycle can never loop forever.
  for (let depth = 0; currentId && depth < 6; depth += 1) {
    const category: RuntimeValue = await Category.findOne({
      where: { id: currentId, active: true },
      include: [translationInclude(CategoryTranslation)],
    });
    if (!category) break;
    trail.unshift({
      id: category.id,
      slug: category.slug,
      name: localeName(category.translations, locale)?.name || category.slug,
    });
    currentId = category.parentId;
  }
  return trail;
}

export async function getProduct(slug: RuntimeValue, locale: RuntimeValue) {
  const requestedSlug = String(slug);
  let product: RuntimeValue = await findPublicProduct(requestedSlug);
  let redirectedFrom: string | null = null;
  if (!product) {
    // A renamed slug keeps resolving to the current product; the storefront
    // compares `slug` with the requested one and issues a 301 (BE-SEO).
    const redirect: RuntimeValue = await Redirect.findOne({
      where: { sourcePath: `/product/${requestedSlug}`, active: true },
    });
    const target = String(redirect?.targetPath || "").match(
      /^\/product\/([a-z0-9-]{1,180})$/,
    );
    if (target) product = await findPublicProduct(target[1]!);
    if (product) redirectedFrom = requestedSlug;
  }
  if (!product) throw AppError.notFound("Product not found.");
  const inventory: RuntimeValue = await settingValue("inventory");
  const dto: RuntimeValue = publicProduct(
    product,
    locale,
    true,
    inventory?.showExactStock !== false,
  );
  const [fitRows, ratingRows, breadcrumbs]: RuntimeValue = await Promise.all([
    Review.findAll({
      where: {
        productId: product.id,
        status: "approved",
        fit: { [Op.ne]: null },
      },
      attributes: [
        "fit",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["fit"],
      raw: true,
    }),
    Review.findAll({
      where: { productId: product.id, status: "approved" },
      attributes: [
        "rating",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["rating"],
      raw: true,
    }),
    categoryTrail(product.categoryId, locale),
  ]);
  const linked: RuntimeValue = await product.getRelatedTargets({
    where: { status: "published", visibility: { [Op.in]: PUBLIC_VISIBILITY } },
    include: publicProductInclude,
    joinTableAttributes: ["relation", "displayOrder"],
    limit: 24,
  });
  const linkedAs = (relations: string[]) =>
    linked
      .filter((item: RuntimeValue) =>
        relations.includes(item.RelatedProduct?.relation),
      )
      .sort(
        (left: RuntimeValue, right: RuntimeValue) =>
          Number(left.RelatedProduct?.displayOrder || 0) -
          Number(right.RelatedProduct?.displayOrder || 0),
      );
  let related: RuntimeValue = linkedAs(["related", "upsell"]);
  // Without curated links, "you may also like" falls back to the same
  // category so the rail is never empty for new products.
  if (!related.length && product.categoryId)
    related = await Product.findAll({
      where: {
        id: { [Op.ne]: product.id },
        categoryId: product.categoryId,
        status: "published",
        visibility: { [Op.in]: PUBLIC_VISIBILITY },
      },
      include: publicProductInclude,
      order: [
        ["featured", "DESC"],
        ["publishedAt", "DESC"],
        ["id", "ASC"],
      ],
      limit: 8,
    });
  const showExact = inventory?.showExactStock !== false;
  const card = (item: RuntimeValue) =>
    publicProduct(item, locale, false, showExact);
  // Attribute options: only values this product's active variants actually
  // use, each flagged with whether any purchasable variant still offers it,
  // so the PDP can disable impossible choices (FE-UX-002).
  const variantRows: RuntimeValue[] = dto.variants;
  const attributes = (product.attributesDefinition || [])
    .filter(
      (attribute: RuntimeValue) =>
        attribute.ProductAttribute?.visible !== false,
    )
    .sort(
      (left: RuntimeValue, right: RuntimeValue) =>
        Number(left.ProductAttribute?.displayOrder || 0) -
        Number(right.ProductAttribute?.displayOrder || 0),
    )
    .map((attribute: RuntimeValue) => ({
      id: attribute.id,
      key: attribute.key,
      type: attribute.type,
      variation: attribute.ProductAttribute?.variation !== false,
      label: localeName(attribute.translations, locale)?.label || attribute.key,
      values: attribute.values
        .filter((value: RuntimeValue) =>
          variantRows.some(
            (variant: RuntimeValue) =>
              variant.attributes?.[attribute.key] === value.value,
          ),
        )
        .sort(
          (left: RuntimeValue, right: RuntimeValue) =>
            Number(left.displayOrder || 0) - Number(right.displayOrder || 0),
        )
        .map((value: RuntimeValue) => ({
          id: value.id,
          slug: value.slug,
          value: value.value,
          label: localeName(value.translations, locale)?.label || value.value,
          colorHex: value.colorHex,
          available: variantRows.some(
            (variant: RuntimeValue) =>
              variant.available &&
              variant.attributes?.[attribute.key] === value.value,
          ),
        })),
    }));
  return {
    ...dto,
    redirectedFrom,
    breadcrumbs,
    categories: (product.categories || []).map((item: RuntimeValue) =>
      taxonomyDto(item, locale),
    ),
    collections: (product.collections || []).map((item: RuntimeValue) =>
      taxonomyDto(item, locale),
    ),
    attributes,
    sizeCharts: (product.sizeCharts || []).map((chart: RuntimeValue) => ({
      id: chart.id,
      title: locale === "bn" ? chart.titleBn : chart.titleEn,
      units: chart.units,
      rows: [...chart.rows]
        .sort(
          (left: RuntimeValue, right: RuntimeValue) =>
            left.displayOrder - right.displayOrder,
        )
        .map((row: RuntimeValue) => {
          const converted = sizeChartCells(row.cells, chart.units);
          return {
            label: locale === "bn" ? row.labelBn : row.labelEn,
            cells: row.cells,
            cm: converted.cm,
            inch: converted.inch,
          };
        }),
    })),
    related: related.map(card),
    completeTheLook: linkedAs(["cross_sell"]).map(card),
    rating: {
      ...dto.rating,
      distribution: Object.fromEntries(
        [5, 4, 3, 2, 1].map((stars) => [
          stars,
          Number(
            ratingRows.find((row: RuntimeValue) => Number(row.rating) === stars)
              ?.count || 0,
          ),
        ]),
      ),
    },
    fitFeedback: Object.fromEntries(
      ["small", "true_to_size", "large"].map((fit) => [
        fit,
        Number(
          fitRows.find((row: RuntimeValue) => row.fit === fit)?.count || 0,
        ),
      ]),
    ),
  };
}

function findPublicProduct(slug: string) {
  return Product.findOne({
    // Hidden products are not reachable even by direct link; search-only and
    // catalog-only products are.
    where: { slug, status: "published", visibility: { [Op.ne]: "hidden" } },
    include: [
      ...publicProductInclude,
      {
        model: Category,
        as: "categories",
        through: { attributes: [] },
        include: [translationInclude(CategoryTranslation)],
      },
      {
        model: Collection,
        as: "collections",
        through: { attributes: [] },
        where: activeWindowWhere(),
        required: false,
        include: [translationInclude(CollectionTranslation)],
      },
      {
        model: Attribute,
        as: "attributesDefinition",
        through: { attributes: ["variation", "visible", "displayOrder"] },
        include: [
          translationInclude(AttributeTranslation),
          {
            model: AttributeValue,
            as: "values",
            where: { active: true },
            required: false,
            include: [translationInclude(AttributeValueTranslation)],
          },
        ],
      },
      {
        model: SizeChart,
        as: "sizeCharts",
        through: { attributes: [] },
        include: [{ model: SizeChartRow, as: "rows" }],
      },
    ],
  });
}

function taxonomyDto(entity: RuntimeValue, locale: RuntimeValue) {
  const translated: RuntimeValue = localeName(entity.translations, locale);
  return {
    id: entity.id,
    slug: entity.slug,
    name: translated?.name || "",
    description: translated?.description || "",
    imageUrl: entity.image
      ? mediaPublicUrl(entity.image.storageKey)
      : entity.logo
        ? mediaPublicUrl(entity.logo.storageKey)
        : null,
  };
}

export async function listCategories(locale: RuntimeValue) {
  const categories: RuntimeValue = await Category.findAll({
    where: { active: true },
    include: [
      translationInclude(CategoryTranslation),
      { model: MediaAsset, as: "image", required: false },
    ],
    order: [["displayOrder", "ASC"]],
  });
  return categories.map((category: RuntimeValue) => ({
    ...taxonomyDto(category, locale),
    parentId: category.parentId,
    displayOrder: category.displayOrder,
  }));
}

export async function getCategory(slug: RuntimeValue, locale: RuntimeValue) {
  const category: RuntimeValue = await Category.findOne({
    where: { slug, active: true },
    include: [
      translationInclude(CategoryTranslation),
      { model: MediaAsset, as: "image", required: false },
      {
        model: Category,
        as: "children",
        where: { active: true },
        required: false,
        include: [translationInclude(CategoryTranslation)],
      },
    ],
  });
  if (!category) throw AppError.notFound("Category not found.");
  return {
    ...taxonomyDto(category, locale),
    children: category.children.map((child: RuntimeValue) =>
      taxonomyDto(child, locale),
    ),
  };
}

export async function listCollections(locale: RuntimeValue) {
  const rows: RuntimeValue = await Collection.findAll({
    where: activeWindowWhere(),
    include: [
      translationInclude(CollectionTranslation),
      { model: MediaAsset, as: "image", required: false },
    ],
    order: [["displayOrder", "ASC"]],
  });
  return rows.map((row: RuntimeValue) => taxonomyDto(row, locale));
}

export async function getCollection(slug: RuntimeValue, locale: RuntimeValue) {
  const row: RuntimeValue = await Collection.findOne({
    where: { slug, ...activeWindowWhere() },
    include: [
      translationInclude(CollectionTranslation),
      { model: MediaAsset, as: "image", required: false },
    ],
  });
  if (!row) throw AppError.notFound("Collection not found.");
  return taxonomyDto(row, locale);
}

export async function listBrands(locale: RuntimeValue) {
  const rows: RuntimeValue = await Brand.findAll({
    where: { active: true },
    include: [
      translationInclude(BrandTranslation),
      { model: MediaAsset, as: "logo", required: false },
    ],
    order: [["displayOrder", "ASC"]],
  });
  return rows.map((row: RuntimeValue) => taxonomyDto(row, locale));
}

export async function listAttributes(locale: RuntimeValue) {
  const rows: RuntimeValue = await Attribute.findAll({
    where: { active: true, filterable: true },
    include: [
      translationInclude(AttributeTranslation),
      {
        model: AttributeValue,
        as: "values",
        where: { active: true },
        required: false,
        include: [translationInclude(AttributeValueTranslation)],
      },
    ],
    order: [
      ["displayOrder", "ASC"],
      [{ model: AttributeValue, as: "values" }, "displayOrder", "ASC"],
    ],
  });
  return rows.map((attribute: RuntimeValue) => ({
    id: attribute.id,
    key: attribute.key,
    type: attribute.type,
    label: localeName(attribute.translations, locale)?.label || attribute.key,
    values: attribute.values.map((value: RuntimeValue) => ({
      id: value.id,
      slug: value.slug,
      // Variant attributes store this raw value; listing filters send it back.
      value: value.value,
      label: localeName(value.translations, locale)?.label || value.value,
      colorHex: value.colorHex,
    })),
  }));
}

export async function searchSuggestions(
  query: RuntimeValue,
  locale: RuntimeValue,
) {
  const term = normalizeSearchTerm(typeof query === "string" ? query : "");
  if (term.length < 2) return [];
  const clause = searchWhereSql(await searchTerms(term));
  if (!clause) return [];
  const [rows, inventory]: RuntimeValue = await Promise.all([
    Product.findAll({
      where: {
        status: "published",
        visibility: { [Op.in]: ["catalog_search", "search"] },
        [Op.and]: [clause],
      },
      include: publicProductInclude,
      limit: 8,
      order: [
        [relevanceSort(term), "ASC"],
        ["reviewCount", "DESC"],
        ["id", "ASC"],
      ],
    }),
    settingValue("inventory"),
  ]);
  return rows.map((row: RuntimeValue) => {
    const product = publicProduct(
      row,
      locale,
      false,
      inventory?.showExactStock !== false,
    );
    // Thumbnail: smallest non-AVIF derivative, else the original.
    const image: RuntimeValue = product.primaryImage;
    const thumbnail =
      image?.variants?.find((item: RuntimeValue) => item.format !== "avif")
        ?.url ||
      image?.url ||
      null;
    return {
      id: product.id,
      slug: product.slug,
      label: product.name || product.slug,
      type: "product",
      image: thumbnail,
      price: product.priceRange?.min || null,
      regularPrice:
        product.variants[0]?.regularPrice || product.priceRange?.min || null,
      onSale: product.onSale,
    };
  });
}
