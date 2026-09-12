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
  StockLocation,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { mediaPublicUrl } from "../media/media.storage.js";

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

function adminProductDto(product: RuntimeValue) {
  return {
    id: product.id,
    slug: product.slug,
    type: product.type,
    status: product.status,
    featured: product.featured,
    visibility: product.visibility,
    taxClass: product.taxClass,
    shippingProfile: product.shippingProfile,
    categoryId: product.categoryId || null,
    categoryIds: (product.categories || []).map(
      (item: RuntimeValue) => item.id,
    ),
    collectionIds: (product.collections || []).map(
      (item: RuntimeValue) => item.id,
    ),
    brandId: product.brandId || null,
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
      costPrice:
        variant.costPrice == null ? null : moneyString(variant.costPrice),
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
  if (query.createdAtFrom) where.createdAt = { ...where.createdAt, [Op.gte]: new Date(query.createdAtFrom) };
  if (query.createdAtTo) where.createdAt = { ...where.createdAt, [Op.lte]: new Date(query.createdAtTo) };
  if (query.updatedAtFrom) where.updatedAt = { ...where.updatedAt, [Op.gte]: new Date(query.updatedAtFrom) };
  if (query.updatedAtTo) where.updatedAt = { ...where.updatedAt, [Op.lte]: new Date(query.updatedAtTo) };
  if (query.search) {
    const term = `%${String(query.search).slice(0, 100)}%`;
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
      version: Number(product.version),
      archivedAt: product.deletedAt || null,
      publishAt: product.publishAt,
      publishedAt: product.publishedAt,
      updatedAt: product.updatedAt,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getAdminProduct(id: RuntimeValue) {
  const product: RuntimeValue = await loadAdminProduct(id);
  if (!product) throw AppError.notFound("Product not found.");
  return adminProductDto(product);
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

function assertPublishable(payload: RuntimeValue) {
  if (!["published", "scheduled"].includes(payload.status)) return;
  const activeVariants: RuntimeValue = payload.variants.filter(
    (variant: RuntimeValue) => (variant.status || "active") === "active",
  );
  if (!payload.categoryId)
    throw AppError.unprocessable(
      "PUBLISH_REQUIREMENTS",
      "A published product needs a primary category.",
      { categoryId: ["Select a primary category."] },
    );
  if (
    !(payload.media || []).some((item: RuntimeValue) => item.role === "primary")
  )
    throw AppError.unprocessable(
      "PUBLISH_REQUIREMENTS",
      "A published product needs a primary image.",
      { media: ["Choose a primary image."] },
    );
  if (!activeVariants.length)
    throw AppError.unprocessable(
      "PUBLISH_REQUIREMENTS",
      "A published product needs an active purchasable variant.",
      { variants: ["Keep at least one active variant."] },
    );
  if (!payload.translations?.en?.name || !payload.translations?.bn?.name)
    throw AppError.unprocessable(
      "PUBLISH_REQUIREMENTS",
      "Published products require English and Bangla names.",
    );
  if (
    payload.status === "scheduled" &&
    (!payload.publishAt || new Date(payload.publishAt) <= new Date())
  )
    throw AppError.unprocessable(
      "INVALID_PUBLISH_SCHEDULE",
      "Choose a future publication time for a scheduled product.",
    );
}

function variantValues(item: RuntimeValue) {
  return {
    sku: item.sku,
    barcode: item.barcode || null,
    title: item.title,
    attributes: item.attributes || {},
    combinationSignature: Object.entries(item.attributes || {})
      .sort(([left]: RuntimeValue, [right]: RuntimeValue) =>
        left.localeCompare(right),
      )
      .map(([key, value]: RuntimeValue) => `${key}:${value}`)
      .join("|"),
    regularPrice: item.regularPrice,
    salePrice: item.salePrice || null,
    costPrice: item.costPrice || null,
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

async function syncVariants(
  product: RuntimeValue,
  payloadVariants: RuntimeValue,
  actorId: RuntimeValue,
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
        { ...variantValues(item), version: variant.version + 1 },
        { transaction },
      );
      if (item.initialStock != null && item.stockPolicy !== "available") {
        const level = await InventoryLevel.findOne({
          where: { variantId: variant.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (level) {
          const delta = Number(item.initialStock) - Number(level.onHand);
          if (delta !== 0) {
            const nextOnHand = Number(level.onHand) + delta;
            if (nextOnHand < 0)
              throw AppError.unprocessable(
                "NEGATIVE_INVENTORY",
                "This adjustment would make on-hand inventory negative.",
              );
            level.onHand = nextOnHand;
            if (item.lowStockThreshold != null)
              level.lowStockThreshold = Number(item.lowStockThreshold);
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
                onHandBefore: Number(level.onHand) - delta,
                balanceAfter: nextOnHand,
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
          ...variantValues(item),
          version: 1,
        },
        { transaction },
      );
      const effectiveOnHand: RuntimeValue = item.stockPolicy === "available" ? 0 : Number(item.initialStock || 0);
      await InventoryLevel.create(
        {
          id: newId(),
          variantId: variant.id,
          locationId: defaultLocation.id,
          onHand: effectiveOnHand,
          reserved: 0,
          lowStockThreshold: Number(item.lowStockThreshold ?? 3),
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
      await variant.setAttributeValues(item.attributeValueIds, { transaction });
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

export async function updateProduct(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  assertPublishable(payload);
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
    await validateReferences(payload, transaction);
    const before: RuntimeValue = adminProductDto(
      await loadAdminProduct(product.id, transaction),
    );
    if (payload.slug !== product.slug) {
      const sourcePath = `/product/${product.slug}`;
      const existingRedirect: RuntimeValue = await Redirect.findOne({
        where: { sourcePath },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        existingRedirect &&
        existingRedirect.targetPath !== `/product/${payload.slug}`
      )
        throw AppError.conflict(
          "SLUG_IN_USE",
          "The previous slug already has a conflicting redirect.",
        );
      if (!existingRedirect)
        await Redirect.create(
          {
            id: newId(),
            sourcePath,
            targetPath: `/product/${payload.slug}`,
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
      transaction,
    );
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
        publishAt: payload.status === "scheduled" ? payload.publishAt : null,
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
    const after: RuntimeValue = adminProductDto(
      await loadAdminProduct(product.id, transaction),
    );
    await recordAudit({
      actorId,
      action: "catalog.product_update",
      resourceType: "product",
      resourceId: product.id,
      before,
      after,
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
    return after;
  });
}

async function assertProductPublishableFromDatabase(
  product: RuntimeValue,
  targetStatus: RuntimeValue,
  publishAt: RuntimeValue,
  transaction: RuntimeValue,
) {
  const [activeVariants, primaryMedia, english, bangla]: RuntimeValue =
    await Promise.all([
      ProductVariant.count({
        where: { productId: product.id, status: "active", active: true },
        transaction,
      }),
      ProductMedia.count({
        where: { productId: product.id, role: "primary" },
        transaction,
      }),
      ProductTranslation.findOne({
        where: { productId: product.id, locale: "en" },
        transaction,
      }),
      ProductTranslation.findOne({
        where: { productId: product.id, locale: "bn" },
        transaction,
      }),
    ]);
  if (
    !product.categoryId ||
    !activeVariants ||
    !primaryMedia ||
    !english?.name ||
    !bangla?.name
  )
    throw AppError.unprocessable(
      "PUBLISH_REQUIREMENTS",
      "Add a primary category, active variant, primary image, and both translations before publishing.",
    );
  if (
    targetStatus === "scheduled" &&
    (!publishAt || new Date(publishAt) <= new Date())
  )
    throw AppError.unprocessable(
      "INVALID_PUBLISH_SCHEDULE",
      "Choose a future publication time.",
    );
}

export async function changePublication(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
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
    return adminProductDto(await loadAdminProduct(product.id, transaction));
  });
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
    product.version += 1;
    await product.save({ transaction });
    await ProductVariant.update(
      { active: false, status: "archived" },
      { where: { productId: product.id }, transaction },
    );
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
  });
}

export async function restoreProduct(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const product: RuntimeValue = await Product.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product || !product.deletedAt)
      throw AppError.notFound("Archived product not found.");
    await product.restore({ transaction });
    product.status = "draft";
    product.publishAt = null;
    product.version += 1;
    await product.save({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.product_restore",
      resourceType: "product",
      resourceId: product.id,
      after: { status: product.status, version: product.version },
      request,
      transaction,
    });
    return adminProductDto(await loadAdminProduct(product.id, transaction));
  });
}

export async function duplicateProduct(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const source: RuntimeValue = await loadAdminProduct(id);
  if (!source) throw AppError.notFound("Product not found.");
  const dto: RuntimeValue = adminProductDto(source);
  const createPayload: RuntimeValue = {
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
    translations: dto.translations,
    variants: dto.variants
      .filter((variant: RuntimeValue) => !variant.archivedAt)
      .map((variant: RuntimeValue, index: RuntimeValue) => ({
        sku: `${payload.skuPrefix}-${String(index + 1).padStart(2, "0")}`,
        barcode: null,
        title: variant.title,
        attributes: variant.attributes,
        regularPrice: variant.regularPrice,
        salePrice: variant.salePrice,
        costPrice: variant.costPrice,
        saleStartsAt: variant.saleStartsAt,
        saleEndsAt: variant.saleEndsAt,
        stockPolicy: variant.stockPolicy,
        preorderAvailableAt: variant.preorderAvailableAt,
        status: variant.status,
        isDefault: variant.isDefault,
        stock: payload.copyStock
          ? variant.inventory.reduce(
              (sum: RuntimeValue, level: RuntimeValue) => sum + level.onHand,
              0,
            )
          : 0,
        lowStockThreshold: variant.inventory[0]?.lowStockThreshold || 3,
      })),
    media: dto.media.map((item: RuntimeValue) => ({
      mediaId: item.mediaId,
      role: item.role,
      displayOrder: item.displayOrder,
      altEn: item.altEn,
      altBn: item.altBn,
    })),
  };
  const { createProduct }: RuntimeValue = await import("./catalog.service.js");
  const created: RuntimeValue = await createProduct(
    createPayload,
    actorId,
    request,
  );
  await sequelize.transaction(async (transaction: RuntimeValue) =>
    recordAudit({
      actorId,
      action: "catalog.product_duplicate",
      resourceType: "product",
      resourceId: created.id,
      metadata: { sourceProductId: id },
      request,
      transaction,
    }),
  );
  return getAdminProduct(created.id);
}

export async function bulkUpdateProducts(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
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
