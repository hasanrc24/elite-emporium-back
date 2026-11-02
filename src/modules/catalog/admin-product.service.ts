import { literal, Op } from "sequelize";
import {
  Attribute,
  AttributeTranslation,
  AttributeValue,
  AttributeValueTranslation,
  Brand,
  Category,
  Collection,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  MediaAsset,
  Product,
  ProductAttribute,
  ProductMedia,
  ProductTranslation,
  ProductVariant,
  Redirect,
  SizeChart,
  StockLocation,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { moneyString } from "../../lib/money.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { resolveLowStockThreshold } from "../inventory/low-stock.js";
import { mediaPublicUrl } from "../media/media.storage.js";
import { settingValue } from "../settings/settings.service.js";
import { assertPublishable, publicationErrors } from "./publication.js";
import type { PublicationInput } from "./publication.js";
import { combinationSignature } from "./product.schemas.js";

/** What the calling admin may see or change beyond `catalog.manage`. */
interface AdminAccess {
  /** `catalog.cost`: read and write variant cost prices. */
  cost: boolean;
  /** `catalog.publish`: change publication state. */
  publish: boolean;
}
const FULL_ACCESS: AdminAccess = { cost: true, publish: true };

const adminProductInclude: RuntimeValue = [
  { model: ProductTranslation, as: "translations" },
  { model: Category, as: "category", required: false },
  { model: Brand, as: "brand", required: false },
  {
    model: Category,
    as: "categories",
    through: { attributes: [] },
    required: false,
  },
  {
    model: Collection,
    as: "collections",
    through: { attributes: [] },
    required: false,
  },
  {
    model: Product,
    as: "relatedTargets",
    attributes: ["id", "slug", "status"],
    through: { attributes: ["relation", "displayOrder"] },
    include: [{ model: ProductTranslation, as: "translations" }],
    required: false,
  },
  {
    model: ProductVariant,
    as: "variants",
    separate: true,
    paranoid: false,
    order: [
      ["isDefault", "DESC"],
      ["createdAt", "ASC"],
    ],
    include: [
      {
        model: InventoryLevel,
        as: "inventoryLevels",
        include: [{ model: StockLocation, as: "location" }],
      },
      {
        model: AttributeValue,
        as: "attributeValues",
        through: { attributes: [] },
        include: [{ model: AttributeValueTranslation, as: "translations" }],
      },
    ],
  },
  {
    model: ProductMedia,
    as: "media",
    separate: true,
    order: [["displayOrder", "ASC"]],
    include: [{ model: MediaAsset, as: "asset" }],
  },
  {
    model: SizeChart,
    as: "sizeCharts",
    attributes: ["id", "name"],
    through: { attributes: [] },
    required: false,
  },
  {
    model: Attribute,
    as: "attributesDefinition",
    through: { attributes: ["variation", "visible", "displayOrder"] },
    include: [{ model: AttributeTranslation, as: "translations" }],
  },
];

function translationsDto(rows: RuntimeValue, fields: RuntimeValue) {
  return Object.fromEntries(
    ["en", "bn"].map((locale: RuntimeValue) => {
      const row: RuntimeValue = rows?.find(
        (translation: RuntimeValue) => translation.locale === locale,
      );
      return [
        locale,
        Object.fromEntries(
          fields.map((field: RuntimeValue) => [field, row?.[field] ?? null]),
        ),
      ];
    }),
  );
}

function relationsDto(targets: RuntimeValue = []) {
  const ordered = [...targets].sort(
    (left: RuntimeValue, right: RuntimeValue) =>
      Number(left.RelatedProduct?.displayOrder || 0) -
      Number(right.RelatedProduct?.displayOrder || 0),
  );
  const pick = (relation: string) =>
    ordered
      .filter(
        (item: RuntimeValue) => item.RelatedProduct?.relation === relation,
      )
      .map((item: RuntimeValue) => ({
        id: item.id,
        slug: item.slug,
        status: item.status,
        name:
          (item.translations || []).find(
            (row: RuntimeValue) => row.locale === "en",
          )?.name || item.slug,
      }));
  return { related: pick("related"), cross_sell: pick("cross_sell") };
}

/** Replaces the product's related and complete-the-look links in order. */
async function syncRelations(
  productId: string,
  relations: RuntimeValue,
  transaction: RuntimeValue,
) {
  const rows = (["related", "cross_sell"] as const).flatMap((relation) =>
    [...new Set<string>(relations[relation] || [])]
      .filter((targetId) => targetId !== productId)
      .map((targetId, displayOrder) => ({ relation, targetId, displayOrder })),
  );
  await assertEntityIds(
    Product,
    rows.map((row) => row.targetId),
    "INVALID_RELATED_PRODUCT",
    "One or more linked products do not exist.",
    transaction,
  );
  await sequelize.query(
    "DELETE FROM related_products WHERE sourceProductId = ? AND relation IN ('related', 'cross_sell')",
    { replacements: [productId], transaction },
  );
  for (const row of rows)
    await sequelize.query(
      "INSERT INTO related_products (sourceProductId, targetProductId, relation, displayOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      {
        replacements: [productId, row.targetId, row.relation, row.displayOrder],
        transaction,
      },
    );
}

function adminProductDto(
  product: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  return {
    id: product.id,
    slug: product.slug,
    type: product.type,
    status: product.status,
    featured: product.featured,
    visibility: product.visibility,
    taxClass: product.taxClass,
    shippingProfile: product.shippingProfile,
    fashion: product.fashion || null,
    lowStockThreshold: product.lowStockThreshold ?? null,
    sizeChartIds: (product.sizeCharts || []).map(
      (item: RuntimeValue) => item.id,
    ),
    sizeCharts: (product.sizeCharts || []).map((item: RuntimeValue) => ({
      id: item.id,
      name: item.name,
    })),
    categoryId: product.categoryId || null,
    categoryIds: (product.categories || []).map(
      (item: RuntimeValue) => item.id,
    ),
    collectionIds: (product.collections || []).map(
      (item: RuntimeValue) => item.id,
    ),
    brandId: product.brandId || null,
    relations: relationsDto(product.relatedTargets),
    translations: translationsDto(product.translations, [
      "name",
      "shortDescription",
      "description",
      "careText",
      "materialText",
      "seoTitle",
      "seoDescription",
    ]),
    variants: (product.variants || []).map((variant: RuntimeValue) => ({
      id: variant.id,
      sku: variant.sku,
      barcode: variant.barcode,
      title: variant.title,
      attributes: variant.attributes || {},
      attributeValueIds: (variant.attributeValues || []).map(
        (value: RuntimeValue) => value.id,
      ),
      regularPrice: moneyString(variant.regularPrice),
      salePrice:
        variant.salePrice == null ? null : moneyString(variant.salePrice),
      ...(access.cost
        ? {
            costPrice:
              variant.costPrice == null ? null : moneyString(variant.costPrice),
          }
        : {}),
      lowStockThreshold: variant.lowStockThreshold ?? null,
      saleStartsAt: variant.saleStartsAt,
      saleEndsAt: variant.saleEndsAt,
      stockPolicy: variant.stockPolicy,
      preorderAvailableAt: variant.preorderAvailableAt,
      preorderMessage: variant.preorderMessage,
      weightGrams: variant.weightGrams,
      dimensions: variant.dimensions,
      status: variant.status,
      active: variant.active,
      isDefault: variant.isDefault,
      version: Number(variant.version),
      archivedAt: variant.deletedAt || null,
      inventory: (variant.inventoryLevels || []).map((level: RuntimeValue) => ({
        id: level.id,
        location: level.location
          ? {
              id: level.location.id,
              code: level.location.code,
              name: level.location.name,
              active: level.location.active,
            }
          : null,
        onHand: Number(level.onHand),
        reserved: Number(level.reserved),
        available: Math.max(0, Number(level.onHand) - Number(level.reserved)),
        lowStockThreshold: Number(level.lowStockThreshold),
        version: Number(level.version),
      })),
    })),
    media: (product.media || []).map((item: RuntimeValue) => ({
      id: item.id,
      mediaId: item.mediaId,
      variantId: item.variantId || null,
      role: item.role,
      displayOrder: Number(item.displayOrder),
      altEn: item.altEn,
      altBn: item.altBn,
      asset: item.asset
        ? {
            id: item.asset.id,
            url:
              item.asset.privacy === "public"
                ? mediaPublicUrl(item.asset.storageKey)
                : null,
            variants: item.asset.metadata?.variants || [],
            width: item.asset.width,
            height: item.asset.height,
            status: item.asset.status,
          }
        : null,
    })),
    attributes: (product.attributesDefinition || []).map(
      (attribute: RuntimeValue) => ({
        id: attribute.id,
        key: attribute.key,
        type: attribute.type,
        variation: Boolean(attribute.ProductAttribute?.variation),
        visible: Boolean(attribute.ProductAttribute?.visible),
        displayOrder: Number(attribute.ProductAttribute?.displayOrder || 0),
        translations: translationsDto(attribute.translations, ["label"]),
      }),
    ),
    reviewAverage: Number(product.reviewAverage || 0),
    reviewCount: Number(product.reviewCount || 0),
    publishAt: product.publishAt,
    publishedAt: product.publishedAt,
    version: Number(product.version),
    archivedAt: product.deletedAt || null,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** Audit trails never carry cost prices; only whether they changed. */
function auditView(dto: RuntimeValue) {
  return {
    ...dto,
    variants: dto.variants.map((variant: RuntimeValue) => {
      const { costPrice, ...rest } = variant;
      return { ...rest, hasCostPrice: costPrice != null };
    }),
  };
}

async function loadAdminProduct(
  id: RuntimeValue,
  transaction: RuntimeValue = null,
) {
  return Product.findByPk(id, {
    paranoid: false,
    include: adminProductInclude,
    transaction,
  });
}

export async function listAdminProducts(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status === "archived") where.deletedAt = { [Op.ne]: null };
  else if (query.status) {
    where.status = query.status;
    where.deletedAt = null;
  }
  if (query.type) where.type = query.type;
  if (query.visibility) where.visibility = query.visibility;
  if (query.featured === "true") where.featured = true;
  if (query.featured === "false") where.featured = false;
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.brandId) where.brandId = query.brandId;
  if (query.createdAtFrom)
    where.createdAt = {
      ...where.createdAt,
      [Op.gte]: new Date(query.createdAtFrom),
    };
  if (query.createdAtTo)
    where.createdAt = {
      ...where.createdAt,
      [Op.lte]: new Date(query.createdAtTo),
    };
  if (query.updatedAtFrom)
    where.updatedAt = {
      ...where.updatedAt,
      [Op.gte]: new Date(query.updatedAtFrom),
    };
  if (query.updatedAtTo)
    where.updatedAt = {
      ...where.updatedAt,
      [Op.lte]: new Date(query.updatedAtTo),
    };
  if (query.search) {
    const term = likeContains(query.search, 100);
    const escapedTerm = sequelize.escape(term);
    where[Op.or] = [
      { slug: { [Op.like]: term } },
      literal(
        `EXISTS (SELECT 1 FROM product_translations pt WHERE pt.productId = Product.id AND pt.name LIKE ${escapedTerm})`,
      ),
      literal(
        `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.productId = Product.id AND pv.sku LIKE ${escapedTerm})`,
      ),
    ];
  }
  const includes: RuntimeValue = [
    { model: ProductTranslation, as: "translations" },
    {
      model: ProductVariant,
      as: "variants",
      paranoid: false,
      required: false,
      attributes: [
        "id",
        "sku",
        "title",
        "regularPrice",
        "salePrice",
        "status",
        "active",
      ],
    },
    { model: Category, as: "category", required: false },
    { model: Brand, as: "brand", required: false },
    // First ready image for the list thumbnail; `separate` keeps paging exact.
    {
      model: ProductMedia,
      as: "media",
      separate: true,
      order: [["displayOrder", "ASC"]],
      include: [
        {
          model: MediaAsset,
          as: "asset",
          where: { status: "ready" },
          required: true,
        },
      ],
    },
  ];
  if (query.collectionId)
    includes.push({
      model: Collection,
      as: "collections",
      through: { attributes: [] },
      where: { id: query.collectionId },
      required: true,
    });
  const result: RuntimeValue = await Product.findAndCountAll({
    where,
    paranoid: false,
    include: includes,
    distinct: true,
    limit,
    offset,
    order: [["updatedAt", "DESC"]],
  });
  return {
    data: result.rows.map((product: RuntimeValue) => ({
      id: product.id,
      slug: product.slug,
      name:
        product.translations?.find((item: RuntimeValue) => item.locale === "en")
          ?.name || product.slug,
      type: product.type,
      status: product.status,
      visibility: product.visibility,
      featured: product.featured,
      category: product.category
        ? { id: product.category.id, slug: product.category.slug }
        : null,
      brand: product.brand
        ? { id: product.brand.id, slug: product.brand.slug }
        : null,
      variants: (product.variants || []).map((variant: RuntimeValue) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        regularPrice: moneyString(variant.regularPrice),
        salePrice:
          variant.salePrice == null ? null : moneyString(variant.salePrice),
        status: variant.status,
        active: variant.active,
      })),
      primaryImage: product.media?.[0]
        ? {
            url: mediaPublicUrl(product.media[0].asset.storageKey),
            alt: product.media[0].altEn || product.media[0].asset.altText || "",
          }
        : null,
      version: Number(product.version),
      archivedAt: product.deletedAt || null,
      publishAt: product.publishAt,
      publishedAt: product.publishedAt,
      updatedAt: product.updatedAt,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getAdminProduct(
  id: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  const product: RuntimeValue = await loadAdminProduct(id);
  if (!product) throw AppError.notFound("Product not found.");
  return adminProductDto(product, access);
}

async function assertEntityIds(
  model: RuntimeValue,
  ids: RuntimeValue,
  code: RuntimeValue,
  message: RuntimeValue,
  transaction: RuntimeValue,
) {
  const unique: RuntimeValue = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return;
  const count: RuntimeValue = await model.count({
    where: { id: { [Op.in]: unique } },
    transaction,
  });
  if (count !== unique.length) throw AppError.unprocessable(code, message);
}

async function validateReferences(
  payload: RuntimeValue,
  transaction: RuntimeValue,
) {
  await assertEntityIds(
    Category,
    [payload.categoryId, ...(payload.categoryIds || [])],
    "INVALID_CATEGORY",
    "One or more selected categories do not exist.",
    transaction,
  );
  await assertEntityIds(
    Collection,
    payload.collectionIds,
    "INVALID_COLLECTION",
    "One or more selected collections do not exist.",
    transaction,
  );
  await assertEntityIds(
    Brand,
    [payload.brandId],
    "INVALID_BRAND",
    "Selected brand does not exist.",
    transaction,
  );
  await assertEntityIds(
    Attribute,
    (payload.attributes || []).map((item: RuntimeValue) => item.attributeId),
    "INVALID_ATTRIBUTE",
    "One or more selected attributes do not exist.",
    transaction,
  );
  const mediaIds: RuntimeValue = [
    ...new Set((payload.media || []).map((item: RuntimeValue) => item.mediaId)),
  ];
  if (mediaIds.length) {
    const count: RuntimeValue = await MediaAsset.count({
      where: { id: { [Op.in]: mediaIds }, status: "ready", privacy: "public" },
      transaction,
    });
    if (count !== mediaIds.length)
      throw AppError.unprocessable(
        "INVALID_MEDIA",
        "Every product media asset must be public and ready.",
      );
  }
  const attributeValueIds: RuntimeValue = [
    ...new Set(
      (payload.variants || []).flatMap(
        (variant: RuntimeValue) => variant.attributeValueIds || [],
      ),
    ),
  ];
  if (attributeValueIds.length) {
    const count: RuntimeValue = await AttributeValue.count({
      where: { id: { [Op.in]: attributeValueIds }, active: true },
      transaction,
    });
    if (count !== attributeValueIds.length)
      throw AppError.unprocessable(
        "INVALID_ATTRIBUTE_VALUE",
        "One or more selected attribute values are unavailable.",
      );
  }
}

function variantValues(
  item: RuntimeValue,
  access: AdminAccess,
  current: RuntimeValue = null,
) {
  return {
    sku: item.sku,
    barcode: item.barcode || null,
    title: item.title,
    attributes: item.attributes || {},
    combinationSignature: combinationSignature(item.attributes),
    regularPrice: item.regularPrice,
    salePrice: item.salePrice || null,
    // Without catalog.cost the field is neither shown nor writable, so an
    // update must keep whatever is stored.
    costPrice: access.cost
      ? item.costPrice || null
      : (current?.costPrice ?? null),
    lowStockThreshold:
      item.lowStockThreshold === undefined
        ? (current?.lowStockThreshold ?? null)
        : item.lowStockThreshold,
    saleStartsAt: item.saleStartsAt || null,
    saleEndsAt: item.saleEndsAt || null,
    stockPolicy: item.stockPolicy,
    preorderAvailableAt: item.preorderAvailableAt || null,
    preorderMessage: item.preorderMessage || null,
    weightGrams: item.weightGrams ?? null,
    dimensions: item.dimensions || null,
    status: item.status || "active",
    active: (item.status || "active") === "active",
    isDefault: Boolean(item.isDefault),
  };
}

async function saveProductTranslations(
  productId: RuntimeValue,
  translations: RuntimeValue,
  transaction: RuntimeValue,
) {
  for (const locale of ["en", "bn"]) {
    const [row]: RuntimeValue = await ProductTranslation.findOrCreate({
      where: { productId, locale },
      defaults: { id: newId(), productId, locale, ...translations[locale] },
      transaction,
    });
    if (!row.isNewRecord)
      await row.update(translations[locale], { transaction });
  }
}

async function syncAttributes(
  product: RuntimeValue,
  attributes: RuntimeValue,
  transaction: RuntimeValue,
) {
  await ProductAttribute.destroy({
    where: { productId: product.id },
    transaction,
  });
  if (attributes?.length)
    await ProductAttribute.bulkCreate(
      attributes.map((item: RuntimeValue, index: RuntimeValue) => ({
        id: newId(),
        productId: product.id,
        attributeId: item.attributeId,
        variation: item.variation,
        visible: item.visible,
        displayOrder: item.displayOrder ?? index,
      })),
      { transaction },
    );
}

async function syncMedia(
  product: RuntimeValue,
  media: RuntimeValue,
  variantByClientKey: RuntimeValue,
  transaction: RuntimeValue,
) {
  await ProductMedia.destroy({ where: { productId: product.id }, transaction });
  if (!media?.length) return;
  const unresolved: RuntimeValue = media.find(
    (item: RuntimeValue) =>
      item.variantKey &&
      !variantByClientKey.has(item.variantKey) &&
      !variantByClientKey.has(item.variantKey.toLocaleLowerCase("en")),
  );
  if (unresolved)
    throw AppError.unprocessable(
      "INVALID_VARIANT_MEDIA",
      `Media references unknown variant key ${unresolved.variantKey}.`,
    );
  await ProductMedia.bulkCreate(
    media.map((item: RuntimeValue, index: RuntimeValue) => ({
      id: newId(),
      productId: product.id,
      variantId: item.variantKey
        ? (
            variantByClientKey.get(item.variantKey) ||
            variantByClientKey.get(item.variantKey.toLocaleLowerCase("en"))
          )?.id || null
        : null,
      mediaId: item.mediaId,
      role: item.role,
      displayOrder: item.displayOrder ?? index,
      altEn: item.altEn || null,
      altBn: item.altBn || null,
    })),
    { transaction },
  );
}

async function activeDefaultLocation(transaction: RuntimeValue) {
  const location: RuntimeValue = await StockLocation.findOne({
    where: { active: true },
    order: [["createdAt", "ASC"]],
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  if (!location)
    throw AppError.unprocessable(
      "STOCK_LOCATION_REQUIRED",
      "Create an active stock location before adding product variants.",
    );
  return location;
}

function productFieldError(
  status: number,
  code: string,
  message: string,
  fields: Record<string, string[]>,
) {
  return new AppError(status, code, message, fields);
}

export function assertCostAccess(variants: RuntimeValue, access: AdminAccess) {
  if (
    !access.cost &&
    (variants || []).some(
      (item: RuntimeValue) => item.costPrice != null && item.costPrice !== "",
    )
  )
    throw AppError.forbidden(
      "Changing cost prices requires the catalog.cost permission.",
    );
}

/** Slugs stay reserved by archived products and by redirects of other products. */
async function assertSlugAvailable(
  slug: string,
  productId: string | null,
  transaction: RuntimeValue,
) {
  const owner: RuntimeValue = await Product.findOne({
    where: { slug },
    paranoid: false,
    attributes: ["id"],
    transaction,
  });
  if (owner && owner.id !== productId)
    throw productFieldError(
      409,
      "SLUG_IN_USE",
      "This slug is already used by another product.",
      { slug: ["This slug is already used by another product."] },
    );
  if (!productId) {
    const redirect: RuntimeValue = await Redirect.findOne({
      where: { sourcePath: `/product/${slug}` },
      transaction,
    });
    if (redirect)
      throw productFieldError(
        409,
        "SLUG_IN_USE",
        "This slug is reserved by a redirect for another product.",
        { slug: ["This slug is reserved by a redirect."] },
      );
  }
}

/** Field-level SKU and barcode conflicts against every other variant. */
export async function assertVariantKeysFree(
  payloadVariants: RuntimeValue,
  transaction: RuntimeValue,
  field = "variants",
) {
  const skus: string[] = payloadVariants.map((item: RuntimeValue) => item.sku);
  const barcodes: string[] = payloadVariants
    .map((item: RuntimeValue) => item.barcode)
    .filter(Boolean);
  const clauses: RuntimeValue[] = [{ sku: { [Op.in]: skus } }];
  if (barcodes.length) clauses.push({ barcode: { [Op.in]: barcodes } });
  const rows: RuntimeValue = await ProductVariant.findAll({
    where: { [Op.or]: clauses },
    paranoid: false,
    attributes: ["id", "sku", "barcode"],
    transaction,
  });
  const ownIds = new Set(
    payloadVariants
      .filter((item: RuntimeValue) => item.id)
      .map((item: RuntimeValue) => item.id),
  );
  const errors: Record<string, string[]> = {};
  let code = "";
  for (const row of rows) {
    if (ownIds.has(row.id)) continue;
    payloadVariants.forEach((item: RuntimeValue, index: number) => {
      if (String(row.sku).toLowerCase() === String(item.sku).toLowerCase()) {
        errors[field ? `${field}.${index}.sku` : "sku"] = [
          `SKU ${item.sku} is already used by another variant.`,
        ];
        code ||= "DUPLICATE_SKU";
      }
      if (
        item.barcode &&
        row.barcode &&
        String(row.barcode).toLowerCase() === String(item.barcode).toLowerCase()
      ) {
        errors[field ? `${field}.${index}.barcode` : "barcode"] = [
          `Barcode ${item.barcode} is already used by another variant.`,
        ];
        code ||= "DUPLICATE_BARCODE";
      }
    });
  }
  if (code)
    throw productFieldError(
      409,
      code,
      "A SKU or barcode is already used by another variant.",
      errors,
    );
}

export async function globalLowStockThreshold(transaction: RuntimeValue) {
  return (await settingValue("inventory", transaction))?.lowStockThreshold;
}

/**
 * Keeps inventory_levels.lowStockThreshold equal to the resolved
 * variant > product > global threshold (BE-INV-001).
 */
async function refreshLevelThresholds(
  productId: string,
  productThreshold: RuntimeValue,
  transaction: RuntimeValue,
) {
  const global = await globalLowStockThreshold(transaction);
  const variants: RuntimeValue = await ProductVariant.findAll({
    where: { productId },
    attributes: ["id", "lowStockThreshold"],
    include: [{ model: InventoryLevel, as: "inventoryLevels" }],
    order: [["id", "ASC"]],
    transaction,
  });
  for (const variant of variants)
    for (const level of variant.inventoryLevels || []) {
      const resolved = resolveLowStockThreshold({
        variant: variant.lowStockThreshold,
        product: productThreshold,
        global,
      });
      if (Number(level.lowStockThreshold) === resolved) continue;
      await InventoryLevel.update(
        { lowStockThreshold: resolved, version: Number(level.version) + 1 },
        { where: { id: level.id }, transaction },
      );
    }
}

async function minimumProductImages(transaction: RuntimeValue) {
  const value = Number(
    (await settingValue("catalog", transaction))?.minProductImages,
  );
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 20) : 4;
}

/** Builds the publication facts from what is stored, inside the caller's transaction. */
async function publicationInputFor(
  product: RuntimeValue,
  status: string,
  publishAt: RuntimeValue,
  transaction: RuntimeValue,
): Promise<PublicationInput> {
  const [
    variants,
    media,
    translations,
    sizeAttribute,
    sizeCharts,
    minImages,
  ]: RuntimeValue = await Promise.all([
    ProductVariant.findAll({
      where: { productId: product.id },
      attributes: [
        "status",
        "active",
        "regularPrice",
        "stockPolicy",
        "preorderAvailableAt",
      ],
      transaction,
    }),
    ProductMedia.findAll({
      where: { productId: product.id },
      attributes: ["role"],
      transaction,
    }),
    ProductTranslation.findAll({
      where: { productId: product.id },
      attributes: ["locale", "name"],
      transaction,
    }),
    ProductAttribute.findAll({
      where: { productId: product.id, variation: true },
      attributes: ["attributeId"],
      transaction,
    }).then((rows: RuntimeValue) =>
      rows.length
        ? Attribute.count({
            where: {
              id: { [Op.in]: rows.map((row: RuntimeValue) => row.attributeId) },
              key: "size",
            },
            transaction,
          })
        : 0,
    ),
    product.countSizeCharts({ transaction }),
    minimumProductImages(transaction),
  ]);
  const name = (locale: string) =>
    translations.find((row: RuntimeValue) => row.locale === locale)?.name;
  return {
    status,
    publishAt,
    slug: product.slug,
    categoryId: product.categoryId,
    names: { en: name("en"), bn: name("bn") },
    variants: variants.map((row: RuntimeValue) => row.get({ plain: true })),
    primaryImageCount: media.filter(
      (row: RuntimeValue) => row.role === "primary",
    ).length,
    imageCount: media.filter((row: RuntimeValue) =>
      ["primary", "gallery"].includes(row.role),
    ).length,
    minImages,
    requiresSizeChart: Number(sizeAttribute) > 0,
    sizeChartCount: Number(sizeCharts),
  };
}

async function assertProductPublishableFromDatabase(
  product: RuntimeValue,
  status: string,
  publishAt: RuntimeValue,
  transaction: RuntimeValue,
) {
  assertPublishable(
    await publicationInputFor(product, status, publishAt, transaction),
  );
}

async function syncSizeCharts(
  product: RuntimeValue,
  sizeChartIds: string[],
  transaction: RuntimeValue,
) {
  const unique = [...new Set(sizeChartIds)];
  await assertEntityIds(
    SizeChart,
    unique,
    "INVALID_SIZE_CHART",
    "One or more selected size charts do not exist.",
    transaction,
  );
  await product.setSizeCharts(unique, { transaction });
}

/**
 * Replaces a variant's attribute values. Sequelize's association setter only
 * writes the two join keys, but `variant_attribute_values` also needs
 * `attributeId` (it enforces one value per attribute), so write rows directly.
 */
export async function setVariantAttributeValues(
  variantId: string,
  valueIds: RuntimeValue,
  transaction: RuntimeValue,
) {
  const unique: string[] = [...new Set<string>(valueIds || [])];
  const values: RuntimeValue = unique.length
    ? await AttributeValue.findAll({
        where: { id: unique },
        attributes: ["id", "attributeId"],
        transaction,
      })
    : [];
  if (values.length !== unique.length)
    throw AppError.unprocessable(
      "UNKNOWN_ATTRIBUTE_VALUE",
      "One of the selected option values no longer exists.",
      { attributeValueIds: ["Refresh the options and try again."] },
    );
  const attributeIds = values.map((value: RuntimeValue) => value.attributeId);
  if (new Set(attributeIds).size !== attributeIds.length)
    throw AppError.unprocessable(
      "DUPLICATE_ATTRIBUTE_VALUE",
      "A variant can have only one value per option.",
      { attributeValueIds: ["Choose one value per option."] },
    );
  await sequelize.query(
    "DELETE FROM variant_attribute_values WHERE variantId = ?",
    { replacements: [variantId], transaction },
  );
  if (!values.length) return;
  await sequelize.query(
    `INSERT INTO variant_attribute_values (variantId, attributeId, valueId, createdAt, updatedAt) VALUES ${values.map(() => "(?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))").join(", ")}`,
    {
      replacements: values.flatMap((value: RuntimeValue) => [
        variantId,
        value.attributeId,
        value.id,
      ]),
      transaction,
    },
  );
}

async function syncVariants(
  product: RuntimeValue,
  payloadVariants: RuntimeValue,
  actorId: RuntimeValue,
  access: AdminAccess,
  transaction: RuntimeValue,
) {
  const existing: RuntimeValue = await ProductVariant.findAll({
    where: { productId: product.id },
    paranoid: false,
    order: [["id", "ASC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const byId: RuntimeValue = new Map(
    existing.map((variant: RuntimeValue) => [variant.id, variant]),
  );
  const incomingIds = new Set(
    payloadVariants
      .filter((item: RuntimeValue) => item.id)
      .map((item: RuntimeValue) => item.id),
  );
  if ([...incomingIds].some((id: RuntimeValue) => !byId.has(id)))
    throw AppError.unprocessable(
      "INVALID_VARIANT",
      "One or more variants do not belong to this product.",
    );
  const lowerSkus: RuntimeValue = payloadVariants.map((item: RuntimeValue) =>
    item.sku.toLocaleLowerCase("en"),
  );
  if (new Set(lowerSkus).size !== lowerSkus.length)
    throw AppError.unprocessable(
      "DUPLICATE_SKU",
      "Variant SKUs must be unique.",
    );
  await assertVariantKeysFree(payloadVariants, transaction);
  const defaultLocation: RuntimeValue = payloadVariants.some(
    (item: RuntimeValue) => !item.id,
  )
    ? await activeDefaultLocation(transaction)
    : null;
  const variantByClientKey: RuntimeValue = new Map();
  for (const [index, item] of payloadVariants.entries()) {
    let variant;
    if (item.id) {
      variant = byId.get(item.id);
      if (Number(item.version) !== Number(variant.version))
        throw AppError.conflict(
          "VERSION_CONFLICT",
          `Variant ${variant.sku} changed. Refresh and review the latest version.`,
        );
      if (variant.deletedAt)
        throw AppError.conflict(
          "VARIANT_ARCHIVED",
          `Restore variant ${variant.sku} before editing it.`,
        );
      await variant.update(
        {
          ...variantValues(item, access, variant),
          version: variant.version + 1,
        },
        { transaction },
      );
      if (item.initialStock != null && item.stockPolicy !== "available") {
        const level = await InventoryLevel.findOne({
          where: { variantId: variant.id },
          order: [["id", "ASC"]],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (level) {
          const delta = Number(item.initialStock) - Number(level.onHand);
          if (delta !== 0) {
            const onHandBefore = Number(level.onHand);
            level.onHand = Number(item.initialStock);
            level.version += 1;
            await level.save({ transaction });
            await InventoryMovement.create(
              {
                id: newId(),
                variantId: variant.id,
                locationId: level.locationId,
                actorId,
                quantityDelta: delta,
                reservedDelta: 0,
                onHandBefore,
                balanceAfter: Number(level.onHand),
                reservedAfter: Number(level.reserved),
                reason: "manual_correction",
                correlationId: `product:${product.id}:variant:${variant.id}`,
              },
              { transaction },
            );
          }
        }
      }
    } else {
      variant = await ProductVariant.create(
        {
          id: newId(),
          productId: product.id,
          ...variantValues(item, access),
          version: 1,
        },
        { transaction },
      );
      const effectiveOnHand: RuntimeValue =
        item.stockPolicy === "available"
          ? 0
          : Number(item.initialStock ?? item.stock ?? 0);
      await InventoryLevel.create(
        {
          id: newId(),
          variantId: variant.id,
          locationId: defaultLocation.id,
          onHand: effectiveOnHand,
          reserved: 0,
          // Resolved to the real variant > product > global value afterwards.
          lowStockThreshold: 3,
          version: 1,
        },
        { transaction },
      );
      if (effectiveOnHand)
        await InventoryMovement.create(
          {
            id: newId(),
            variantId: variant.id,
            locationId: defaultLocation.id,
            actorId,
            quantityDelta: effectiveOnHand,
            reservedDelta: 0,
            onHandBefore: 0,
            balanceAfter: effectiveOnHand,
            reservedAfter: 0,
            reason: "initial_stock",
            correlationId: `product:${product.id}:variant:${variant.id}`,
          },
          { transaction },
        );
    }
    if (item.attributeValueIds)
      await setVariantAttributeValues(
        variant.id,
        item.attributeValueIds,
        transaction,
      );
    variantByClientKey.set(
      item.clientKey || item.id || `index:${index}`,
      variant,
    );
    variantByClientKey.set(item.sku.toLocaleLowerCase("en"), variant);
  }
  for (const variant of existing) {
    if (!incomingIds.has(variant.id) && !variant.deletedAt) {
      variant.status = "archived";
      variant.active = false;
      variant.isDefault = false;
      variant.version += 1;
      await variant.save({ transaction });
    }
  }
  return variantByClientKey;
}

export async function createProduct(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  assertCostAccess(payload.variants, access);
  if (payload.status !== "draft" && !access.publish)
    throw AppError.forbidden(
      "Publishing requires the catalog.publish permission.",
    );
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    await assertSlugAvailable(payload.slug, null, transaction);
    await validateReferences(payload, transaction);
    const hasDefault = payload.variants.some(
      (item: RuntimeValue) => item.isDefault && item.status === "active",
    );
    const variants: RuntimeValue = payload.variants.map(
      (item: RuntimeValue, index: number) => ({
        ...item,
        isDefault:
          item.isDefault ||
          (!hasDefault && index === 0 && item.status === "active"),
      }),
    );
    const product: RuntimeValue = await Product.create(
      {
        id: newId(),
        slug: payload.slug,
        categoryId: payload.categoryId || null,
        brandId: payload.brandId || null,
        type: variants.length > 1 ? "variable" : payload.type,
        status: payload.status,
        featured: payload.featured,
        visibility: payload.visibility,
        taxClass: payload.taxClass,
        shippingProfile: payload.shippingProfile || null,
        fashion: payload.fashion || null,
        lowStockThreshold: payload.lowStockThreshold ?? null,
        publishAt:
          payload.status === "scheduled" ? new Date(payload.publishAt) : null,
        publishedAt: payload.status === "published" ? new Date() : null,
        version: 1,
      },
      { transaction },
    );
    await saveProductTranslations(
      product.id,
      payload.translations,
      transaction,
    );
    const variantByKey: RuntimeValue = await syncVariants(
      product,
      variants,
      actorId,
      access,
      transaction,
    );
    await product.setCategories(
      [
        ...new Set(
          [payload.categoryId, ...(payload.categoryIds || [])].filter(Boolean),
        ),
      ],
      { transaction },
    );
    await product.setCollections([...new Set(payload.collectionIds || [])], {
      transaction,
    });
    await syncAttributes(product, payload.attributes || [], transaction);
    await syncMedia(
      product,
      (payload.media || []).map((item: RuntimeValue) => ({
        ...item,
        variantKey: item.variantSku,
      })),
      variantByKey,
      transaction,
    );
    if (payload.sizeChartIds?.length)
      await syncSizeCharts(product, payload.sizeChartIds, transaction);
    await refreshLevelThresholds(
      product.id,
      payload.lowStockThreshold,
      transaction,
    );
    if (["published", "scheduled"].includes(payload.status))
      await assertProductPublishableFromDatabase(
        product,
        payload.status,
        payload.publishAt,
        transaction,
      );
    const created: RuntimeValue = adminProductDto(
      await loadAdminProduct(product.id, transaction),
      access,
    );
    await recordAudit({
      actorId,
      action: "catalog.product_create",
      resourceType: "product",
      resourceId: product.id,
      after: auditView(created),
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "catalog.product_created",
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        slug: product.slug,
        status: product.status,
      },
      transaction,
    });
    if (payload.status !== "draft")
      await addDomainEvent({
        topic: `catalog.product_${payload.status}`,
        aggregateType: "product",
        aggregateId: product.id,
        payload: {
          productId: product.id,
          slug: product.slug,
          status: product.status,
        },
        transaction,
      });
    return created;
  });
}

export async function updateProduct(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  assertCostAccess(payload.variants, access);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const product: RuntimeValue = await Product.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw AppError.notFound("Product not found.");
    if (product.deletedAt)
      throw AppError.conflict(
        "PRODUCT_ARCHIVED",
        "Restore this product before editing it.",
      );
    if (Number(payload.version) !== Number(product.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This product changed. Refresh and review the latest version.",
      );
    const previousStatus: string = product.status;
    const publicationChanged =
      payload.status !== previousStatus ||
      (payload.status === "scheduled" &&
        new Date(payload.publishAt).getTime() !==
          new Date(product.publishAt).getTime());
    if (publicationChanged && !access.publish)
      throw AppError.forbidden(
        "Changing publication state requires the catalog.publish permission.",
      );
    await validateReferences(payload, transaction);
    const before: RuntimeValue = auditView(
      adminProductDto(await loadAdminProduct(product.id, transaction)),
    );
    if (payload.slug !== product.slug) {
      await assertSlugAvailable(payload.slug, product.id, transaction);
      const sourcePath = `/product/${product.slug}`;
      const targetPath = `/product/${payload.slug}`;
      // Reclaiming an earlier slug of this product: drop its old redirect so
      // the two redirects cannot form a loop. A redirect owned by another
      // product keeps that slug reserved.
      const reclaimed: RuntimeValue = await Redirect.findOne({
        where: { sourcePath: targetPath },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (reclaimed && reclaimed.targetPath !== sourcePath)
        throw productFieldError(
          409,
          "SLUG_IN_USE",
          "This slug is reserved by a redirect for another product.",
          { slug: ["This slug is reserved by a redirect."] },
        );
      if (reclaimed) await reclaimed.destroy({ transaction });
      // Keep older slugs pointing straight at the current one.
      await Redirect.update(
        { targetPath },
        { where: { targetPath: sourcePath }, transaction },
      );
      const existingRedirect: RuntimeValue = await Redirect.findOne({
        where: { sourcePath },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (existingRedirect && existingRedirect.targetPath !== targetPath)
        throw productFieldError(
          409,
          "SLUG_IN_USE",
          "The previous slug already has a conflicting redirect.",
          { slug: ["The previous slug already has a conflicting redirect."] },
        );
      if (!existingRedirect)
        await Redirect.create(
          {
            id: newId(),
            sourcePath,
            targetPath,
            statusCode: 301,
            active: true,
          },
          { transaction },
        );
    }
    const variantByClientKey: RuntimeValue = await syncVariants(
      product,
      payload.variants,
      actorId,
      access,
      transaction,
    );
    const productThreshold: RuntimeValue =
      payload.lowStockThreshold === undefined
        ? product.lowStockThreshold
        : payload.lowStockThreshold;
    await product.update(
      {
        slug: payload.slug,
        categoryId: payload.categoryId || null,
        brandId: payload.brandId || null,
        type:
          payload.variants.filter(
            (variant: RuntimeValue) => variant.status === "active",
          ).length > 1
            ? "variable"
            : payload.type,
        status: payload.status,
        featured: payload.featured,
        visibility: payload.visibility,
        taxClass: payload.taxClass,
        shippingProfile: payload.shippingProfile || null,
        fashion: payload.fashion || null,
        lowStockThreshold: productThreshold ?? null,
        publishAt:
          payload.status === "scheduled" ? new Date(payload.publishAt) : null,
        publishedAt:
          payload.status === "published"
            ? product.publishedAt || new Date()
            : product.publishedAt,
        version: product.version + 1,
      },
      { transaction },
    );
    await saveProductTranslations(
      product.id,
      payload.translations,
      transaction,
    );
    await product.setCategories(
      [
        ...new Set(
          [payload.categoryId, ...(payload.categoryIds || [])].filter(Boolean),
        ),
      ],
      { transaction },
    );
    await product.setCollections([...new Set(payload.collectionIds || [])], {
      transaction,
    });
    await syncAttributes(product, payload.attributes || [], transaction);
    await syncMedia(
      product,
      payload.media || [],
      variantByClientKey,
      transaction,
    );
    if (payload.sizeChartIds)
      await syncSizeCharts(product, payload.sizeChartIds, transaction);
    if (payload.relations)
      await syncRelations(product.id, payload.relations, transaction);
    await refreshLevelThresholds(product.id, productThreshold, transaction);
    // Validate what was actually stored; a failure rolls the whole save back.
    if (["published", "scheduled"].includes(payload.status))
      await assertProductPublishableFromDatabase(
        product,
        payload.status,
        payload.publishAt,
        transaction,
      );
    const after: RuntimeValue = adminProductDto(
      await loadAdminProduct(product.id, transaction),
      access,
    );
    await recordAudit({
      actorId,
      action: "catalog.product_update",
      resourceType: "product",
      resourceId: product.id,
      before,
      after: auditView(after),
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "catalog.product_updated",
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        slug: product.slug,
        status: product.status,
        version: product.version,
      },
      transaction,
    });
    if (previousStatus !== payload.status)
      await addDomainEvent({
        topic: `catalog.product_${payload.status}`,
        aggregateType: "product",
        aggregateId: product.id,
        payload: {
          productId: product.id,
          slug: product.slug,
          status: product.status,
        },
        transaction,
      });
    return after;
  });
}

export async function changePublication(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const product: RuntimeValue = await Product.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw AppError.notFound("Product not found.");
    if (Number(payload.version) !== Number(product.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This product changed. Refresh and review the latest version.",
      );
    const before: RuntimeValue = {
      status: product.status,
      publishAt: product.publishAt,
      publishedAt: product.publishedAt,
      version: Number(product.version),
    };
    if (["published", "scheduled"].includes(payload.status))
      await assertProductPublishableFromDatabase(
        product,
        payload.status,
        payload.publishAt,
        transaction,
      );
    product.status = payload.status;
    product.publishAt =
      payload.status === "scheduled" ? new Date(payload.publishAt) : null;
    if (payload.status === "published")
      product.publishedAt = product.publishedAt || new Date();
    product.version += 1;
    await product.save({ transaction });
    await recordAudit({
      actorId,
      action: `catalog.product_${payload.status}`,
      resourceType: "product",
      resourceId: product.id,
      before,
      after: {
        status: product.status,
        publishAt: product.publishAt,
        publishedAt: product.publishedAt,
        version: Number(product.version),
      },
      request,
      transaction,
    });
    await addDomainEvent({
      topic: `catalog.product_${payload.status}`,
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        slug: product.slug,
        status: product.status,
      },
      transaction,
    });
    return adminProductDto(
      await loadAdminProduct(product.id, transaction),
      access,
    );
  });
}

/**
 * Publishes scheduled products that are due. Idempotent: only rows still
 * `scheduled` are touched, the status flip bumps the optimistic `version`, and
 * every product is re-validated first. A product that no longer meets the
 * publication rules is returned to draft with a staff notification instead of
 * going live incomplete.
 */
export async function publishDueProducts(
  now: Date,
  limit: number,
  transaction: RuntimeValue,
) {
  const due: RuntimeValue = await Product.findAll({
    where: { status: "scheduled", publishAt: { [Op.lte]: now } },
    order: [["publishAt", "ASC"]],
    limit,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  let published = 0;
  for (const product of due) {
    const errors = publicationErrors(
      await publicationInputFor(product, "published", null, transaction),
    );
    const before = { status: product.status, version: Number(product.version) };
    product.status = errors ? "draft" : "published";
    product.publishAt = null;
    if (!errors) product.publishedAt = now;
    product.version += 1;
    await product.save({ transaction });
    await recordAudit({
      actorId: null,
      action: errors
        ? "catalog.product_publish_failed"
        : "catalog.product_published",
      resourceType: "product",
      resourceId: product.id,
      before,
      after: { status: product.status, version: Number(product.version) },
      metadata: { scheduled: true, fieldErrors: errors },
      transaction,
    });
    await addDomainEvent({
      topic: errors
        ? "catalog.product_publish_failed"
        : "catalog.product_published",
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        slug: product.slug,
        status: product.status,
        ...(errors ? { fieldErrors: errors } : {}),
      },
      transaction,
    });
    if (errors)
      await notifyStaff("catalog", {
        event: "catalog.publish_failed",
        title: `Scheduled product ${product.slug} was not published`,
        message: Object.values(errors).flat().join(" "),
        link: `/admin/products/${product.id}`,
        severity: "warning",
        data: { productId: product.id },
        transaction,
      });
    else published += 1;
  }
  return published;
}

export async function archiveProduct(
  id: RuntimeValue,
  version: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const product: RuntimeValue = await Product.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw AppError.notFound("Product not found.");
    if (Number(version) !== Number(product.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This product changed. Refresh and review the latest version.",
      );
    const activeReservations: RuntimeValue = await InventoryReservation.count({
      include: [
        {
          model: ProductVariant,
          as: "variant",
          where: { productId: product.id },
          required: true,
          paranoid: false,
        },
      ],
      where: { status: { [Op.in]: ["active", "converted"] } },
      transaction,
    });
    if (activeReservations)
      throw AppError.conflict(
        "PRODUCT_HAS_RESERVATIONS",
        "This product has active order reservations and cannot be archived yet.",
      );
    const before: RuntimeValue = {
      status: product.status,
      version: Number(product.version),
    };
    product.status = "archived";
    product.publishAt = null;
    product.version += 1;
    await product.save({ transaction });
    // Variants are left untouched: the archived product is hidden from cart,
    // checkout and the storefront, and a restore then loses nothing.
    await product.destroy({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.product_archive",
      resourceType: "product",
      resourceId: product.id,
      before,
      after: { status: "archived", archivedAt: new Date() },
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "catalog.product_archived",
      aggregateType: "product",
      aggregateId: product.id,
      payload: { productId: product.id, slug: product.slug },
      transaction,
    });
  });
}

export async function restoreProduct(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const product: RuntimeValue = await Product.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product || !product.deletedAt)
      throw AppError.notFound("Archived product not found.");
    const archivedAt: Date = new Date(product.deletedAt);
    await product.restore({ transaction });
    product.status = "draft";
    product.publishAt = null;
    product.version += 1;
    await product.save({ transaction });
    // Products archived before variants were left untouched had every variant
    // archived in the same moment; bring those back so the draft is usable.
    const stillActive: RuntimeValue = await ProductVariant.count({
      where: { productId: product.id, status: "active", active: true },
      transaction,
    });
    if (!stillActive) {
      const variants: RuntimeValue = await ProductVariant.findAll({
        where: {
          productId: product.id,
          status: "archived",
          updatedAt: { [Op.gte]: new Date(archivedAt.getTime() - 60_000) },
        },
        order: [["createdAt", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const [index, variant] of variants.entries()) {
        variant.status = "active";
        variant.active = true;
        variant.isDefault = index === 0;
        variant.version += 1;
        await variant.save({ transaction });
      }
    }
    await recordAudit({
      actorId,
      action: "catalog.product_restore",
      resourceType: "product",
      resourceId: product.id,
      after: { status: product.status, version: product.version },
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "catalog.product_updated",
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        slug: product.slug,
        status: product.status,
        version: product.version,
      },
      transaction,
    });
    return adminProductDto(
      await loadAdminProduct(product.id, transaction),
      access,
    );
  });
}

export async function duplicateProduct(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  const source: RuntimeValue = await loadAdminProduct(id);
  if (!source) throw AppError.notFound("Product not found.");
  const dto: RuntimeValue = adminProductDto(source);
  const variants: RuntimeValue[] = dto.variants.filter(
    (variant: RuntimeValue) =>
      variant.status === "active" && !variant.archivedAt,
  );
  if (!variants.length)
    throw AppError.unprocessable(
      "NOTHING_TO_DUPLICATE",
      "This product has no active variants to copy.",
    );
  const variantSku = (index: number) =>
    `${payload.skuPrefix}-${String(index + 1).padStart(2, "0")}`;
  const skuByVariantId = new Map(
    variants.map((variant: RuntimeValue, index) => [
      variant.id,
      variantSku(index),
    ]),
  );
  return createProduct(
    {
      slug: payload.slug,
      categoryId: dto.categoryId,
      categoryIds: dto.categoryIds,
      collectionIds: dto.collectionIds,
      brandId: dto.brandId,
      type: dto.type,
      status: "draft",
      featured: false,
      visibility: dto.visibility,
      taxClass: dto.taxClass,
      shippingProfile: dto.shippingProfile,
      fashion: dto.fashion,
      lowStockThreshold: dto.lowStockThreshold,
      sizeChartIds: dto.sizeChartIds,
      translations: dto.translations,
      attributes: dto.attributes.map((attribute: RuntimeValue) => ({
        attributeId: attribute.id,
        variation: attribute.variation,
        visible: attribute.visible,
        displayOrder: attribute.displayOrder,
      })),
      variants: variants.map((variant: RuntimeValue, index: number) => ({
        sku: variantSku(index),
        barcode: null,
        title: variant.title,
        attributes: variant.attributes,
        attributeValueIds: variant.attributeValueIds,
        regularPrice: variant.regularPrice,
        salePrice: variant.salePrice,
        costPrice: access.cost ? variant.costPrice : null,
        lowStockThreshold: variant.lowStockThreshold,
        saleStartsAt: variant.saleStartsAt,
        saleEndsAt: variant.saleEndsAt,
        stockPolicy: variant.stockPolicy,
        preorderAvailableAt: variant.preorderAvailableAt,
        preorderMessage: variant.preorderMessage,
        weightGrams: variant.weightGrams,
        dimensions: variant.dimensions,
        status: "active",
        isDefault: variant.isDefault,
        stock: payload.copyStock
          ? variant.inventory.reduce(
              (sum: RuntimeValue, level: RuntimeValue) => sum + level.onHand,
              0,
            )
          : 0,
      })),
      media: dto.media.map((item: RuntimeValue) => ({
        mediaId: item.mediaId,
        role: item.role,
        displayOrder: item.displayOrder,
        altEn: item.altEn,
        altBn: item.altBn,
        variantSku: item.variantId ? skuByVariantId.get(item.variantId) : null,
      })),
    },
    actorId,
    request,
    access,
  );
}

export async function bulkUpdateProducts(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
  access: AdminAccess = FULL_ACCESS,
) {
  if (payload.status === "draft" && !access.publish)
    throw AppError.forbidden(
      "Unpublishing products requires the catalog.publish permission.",
    );
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const ids: RuntimeValue = [
      ...new Set(payload.items.map((item: RuntimeValue) => item.id)),
    ].sort();
    const rows: RuntimeValue = await Product.findAll({
      where: { id: { [Op.in]: ids } },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (rows.length !== ids.length)
      throw AppError.unprocessable(
        "INVALID_PRODUCT_SELECTION",
        "One or more products do not exist.",
      );
    const versionById = new Map(
      payload.items.map((item: RuntimeValue) => [item.id, item.version]),
    );
    for (const row of rows) {
      if (Number(versionById.get(row.id)) !== Number(row.version))
        throw AppError.conflict(
          "VERSION_CONFLICT",
          `Product ${row.slug} changed. Refresh and retry the selection.`,
        );
      if (payload.featured != null) row.featured = payload.featured;
      if (payload.visibility) row.visibility = payload.visibility;
      if (payload.status === "draft") {
        row.status = "draft";
        row.publishAt = null;
      }
      row.version += 1;
      await row.save({ transaction });
      await addDomainEvent({
        topic: "catalog.product_updated",
        aggregateType: "product",
        aggregateId: row.id,
        payload: {
          productId: row.id,
          slug: row.slug,
          status: row.status,
          version: row.version,
        },
        transaction,
      });
    }
    await recordAudit({
      actorId,
      action: "catalog.product_bulk_update",
      resourceType: "products",
      metadata: {
        ids,
        changes: {
          featured: payload.featured,
          visibility: payload.visibility,
          status: payload.status,
        },
      },
      request,
      transaction,
    });
    return { updated: rows.length, ids };
  });
}
