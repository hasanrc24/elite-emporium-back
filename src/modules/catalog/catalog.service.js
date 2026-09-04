import { literal, Op } from 'sequelize';
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
  InventoryMovement,
  MediaAsset,
  Product,
  ProductAttribute,
  ProductMedia,
  ProductTranslation,
  ProductVariant,
  SizeChart,
  SizeChartRow,
  StockLocation,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { moneyString } from '../../lib/money.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { recordAudit } from '../audits/audit.service.js';
import { mediaPublicUrl } from '../media/media.storage.js';
import { effectivePrice, priceDto } from './pricing.js';

const localeName = (translations = [], locale) => translations.find((item) => item.locale === locale) || translations.find((item) => item.locale === 'en') || translations[0];
const translationInclude = (model, as = 'translations') => ({ model, as });
const variantInclude = {
  model: ProductVariant,
  as: 'variants',
  where: { status: 'active', active: true },
  required: false,
  separate: true,
  order: [['isDefault', 'DESC'], ['createdAt', 'ASC']],
  include: [{ model: InventoryLevel, as: 'inventoryLevels', include: [{ model: StockLocation, as: 'location', where: { active: true }, required: false }] }],
};
const mediaInclude = {
  model: ProductMedia,
  as: 'media',
  separate: true,
  order: [['displayOrder', 'ASC']],
  include: [{ model: MediaAsset, as: 'asset', where: { status: 'ready', privacy: 'public' }, required: true }],
};
const publicProductInclude = [
  translationInclude(ProductTranslation),
  variantInclude,
  mediaInclude,
  { model: Category, as: 'category', include: [translationInclude(CategoryTranslation)] },
  { model: Brand, as: 'brand', include: [translationInclude(BrandTranslation)] },
];

function imageDto(item, locale) {
  return {
    id: item.asset.id,
    role: item.role,
    variantId: item.variantId || null,
    url: mediaPublicUrl(item.asset.storageKey),
    variants: item.asset.metadata?.variants || [],
    width: item.asset.width,
    height: item.asset.height,
    alt: (locale === 'bn' ? item.altBn : item.altEn) || item.asset.altText || '',
  };
}

function availabilityDto(variant) {
  const levels = variant.inventoryLevels || (variant.inventory ? [variant.inventory] : []);
  const availableQuantity = levels.reduce((total, level) => total + Math.max(0, Number(level.onHand || 0) - Number(level.reserved || 0)), 0);
  const lowStockThreshold = levels.reduce((total, level) => total + Number(level.lowStockThreshold || 0), 0);
  return {
    available: variant.stockPolicy !== 'deny' || availableQuantity > 0,
    availableQuantity,
    stockPolicy: variant.stockPolicy,
    lowStock: availableQuantity > 0 && availableQuantity <= lowStockThreshold,
    preorderAvailableAt: variant.preorderAvailableAt || null,
    preorderMessage: variant.preorderMessage || null,
  };
}

export function publicProduct(product, locale = 'en', includeDetail = false) {
  const translation = localeName(product.translations, locale);
  const variants = (product.variants || []).map((variant) => ({
    id: variant.id,
    sku: variant.sku,
    title: variant.title,
    attributes: variant.attributes,
    ...priceDto(variant),
    ...availabilityDto(variant),
    isDefault: variant.isDefault,
    weightGrams: variant.weightGrams,
    dimensions: variant.dimensions,
  }));
  const prices = variants.map((variant) => effectivePrice(variant));
  const images = (product.media || []).map((item) => imageDto(item, locale));
  return {
    id: product.id,
    slug: product.slug,
    type: product.type,
    featured: product.featured,
    name: translation?.name || '',
    shortDescription: translation?.shortDescription || '',
    ...(includeDetail ? {
      description: translation?.description || '',
      careText: translation?.careText || '',
      materialText: translation?.materialText || '',
      seo: { title: translation?.seoTitle || translation?.name || '', description: translation?.seoDescription || translation?.shortDescription || '' },
    } : {}),
    category: product.category ? { id: product.category.id, slug: product.category.slug, name: localeName(product.category.translations, locale)?.name || '' } : null,
    brand: product.brand ? { id: product.brand.id, slug: product.brand.slug, name: localeName(product.brand.translations, locale)?.name || '' } : null,
    images,
    primaryImage: images.find((item) => item.role === 'primary') || images[0] || null,
    variants,
    rating: { average: Number(product.reviewAverage || 0), count: Number(product.reviewCount || 0) },
    priceRange: prices.length ? { min: moneyString(prices.reduce((minimum, price) => price.lessThan(minimum) ? price : minimum)), max: moneyString(prices.reduce((maximum, price) => price.greaterThan(maximum) ? price : maximum)) } : null,
  };
}

function activeWindowWhere() {
  return { active: true, [Op.and]: [{ [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: new Date() } }] }, { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: new Date() } }] }] };
}

function productFilterSql(query) {
  const clauses = [];
  const minimum = Number(query.minPrice);
  const maximum = Number(query.maxPrice);
  const priceExpression = '(CASE WHEN pv.salePrice IS NOT NULL AND (pv.saleStartsAt IS NULL OR pv.saleStartsAt <= UTC_TIMESTAMP(3)) AND (pv.saleEndsAt IS NULL OR pv.saleEndsAt > UTC_TIMESTAMP(3)) AND pv.salePrice < pv.regularPrice THEN pv.salePrice ELSE pv.regularPrice END)';
  if (Number.isFinite(minimum) && minimum >= 0) clauses.push(`${priceExpression} >= ${sequelize.escape(minimum.toFixed(2))}`);
  if (Number.isFinite(maximum) && maximum >= 0) clauses.push(`${priceExpression} <= ${sequelize.escape(maximum.toFixed(2))}`);
  if (query.sale === 'true') clauses.push(`${priceExpression} < pv.regularPrice`);
  if (query.available === 'true') clauses.push("(pv.stockPolicy <> 'deny' OR (il.onHand - il.reserved) > 0)");
  if (!clauses.length) return null;
  return literal(`EXISTS (SELECT 1 FROM product_variants pv LEFT JOIN inventory_levels il ON il.variantId = pv.id WHERE pv.productId = Product.id AND pv.active = 1 AND pv.status = 'active' AND ${clauses.join(' AND ')})`);
}

const priceSort = literal("(SELECT MIN(CASE WHEN pv.salePrice IS NOT NULL AND (pv.saleStartsAt IS NULL OR pv.saleStartsAt <= UTC_TIMESTAMP(3)) AND (pv.saleEndsAt IS NULL OR pv.saleEndsAt > UTC_TIMESTAMP(3)) AND pv.salePrice < pv.regularPrice THEN pv.salePrice ELSE pv.regularPrice END) FROM product_variants pv WHERE pv.productId = Product.id AND pv.active = 1 AND pv.status = 'active')");

export async function listProducts(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = { status: 'published', visibility: { [Op.in]: ['catalog_search', 'catalog'] } };
  const includes = [...publicProductInclude];
  if (query.featured === 'true') where.featured = true;
  if (query.search) where[Op.or] = [{ slug: { [Op.like]: `%${String(query.search).slice(0, 80)}%` } }, { '$translations.name$': { [Op.like]: `%${String(query.search).slice(0, 80)}%` } }];
  if (query.brand) {
    const brand = await Brand.findOne({ where: { slug: query.brand, active: true }, attributes: ['id'] });
    if (!brand) return { data: [], meta: { page, pageSize, total: 0, pageCount: 0 } };
    where.brandId = brand.id;
  }
  if (query.category) {
    const category = await Category.findOne({ where: { slug: query.category, active: true }, attributes: ['id'] });
    if (!category) return { data: [], meta: { page, pageSize, total: 0, pageCount: 0 } };
    includes.push({ model: Category, as: 'categories', attributes: [], through: { attributes: [] }, required: false });
    where[Op.and] = [...(where[Op.and] || []), { [Op.or]: [{ categoryId: category.id }, { '$categories.id$': category.id }] }];
  }
  if (query.collection) includes.push({ model: Collection, as: 'collections', attributes: [], through: { attributes: [] }, where: { slug: query.collection, ...activeWindowWhere() }, required: true });
  const variantFilter = productFilterSql(query);
  if (variantFilter) where[Op.and] = [...(where[Op.and] || []), variantFilter];
  const order = query.sort === 'price_asc' ? [[priceSort, 'ASC']] : query.sort === 'price_desc' ? [[priceSort, 'DESC']] : query.sort === 'rating' ? [['reviewAverage', 'DESC'], ['reviewCount', 'DESC']] : [['featured', 'DESC'], ['publishedAt', 'DESC'], ['createdAt', 'DESC']];
  const result = await Product.findAndCountAll({ where, include: includes, distinct: true, limit, offset, order });
  return { data: result.rows.map((product) => publicProduct(product, query.locale)), meta: pageEnvelope(result, page, pageSize).meta };
}

export async function getProduct(slug, locale) {
  const product = await Product.findOne({ where: { slug, status: 'published', visibility: { [Op.ne]: 'hidden' } }, include: [
    ...publicProductInclude,
    { model: Category, as: 'categories', through: { attributes: [] }, include: [translationInclude(CategoryTranslation)] },
    { model: Collection, as: 'collections', through: { attributes: [] }, where: activeWindowWhere(), required: false, include: [translationInclude(CollectionTranslation)] },
    { model: Attribute, as: 'attributesDefinition', through: { attributes: ['variation', 'visible', 'displayOrder'] }, include: [translationInclude(AttributeTranslation), { model: AttributeValue, as: 'values', where: { active: true }, required: false, include: [translationInclude(AttributeValueTranslation)] }] },
    { model: SizeChart, as: 'sizeCharts', through: { attributes: [] }, include: [{ model: SizeChartRow, as: 'rows' }] },
  ] });
  if (!product) throw AppError.notFound('Product not found.');
  const dto = publicProduct(product, locale, true);
  const related = await product.getRelatedTargets({ where: { status: 'published', visibility: { [Op.ne]: 'hidden' } }, include: publicProductInclude, limit: 12 });
  return {
    ...dto,
    categories: (product.categories || []).map((item) => taxonomyDto(item, locale)),
    collections: (product.collections || []).map((item) => taxonomyDto(item, locale)),
    attributes: (product.attributesDefinition || []).map((attribute) => ({ id: attribute.id, key: attribute.key, type: attribute.type, label: localeName(attribute.translations, locale)?.label || attribute.key, values: attribute.values.map((value) => ({ id: value.id, slug: value.slug, value: value.value, label: localeName(value.translations, locale)?.label || value.value, colorHex: value.colorHex })) })),
    sizeCharts: (product.sizeCharts || []).map((chart) => ({ id: chart.id, title: locale === 'bn' ? chart.titleBn : chart.titleEn, units: chart.units, rows: chart.rows.sort((left, right) => left.displayOrder - right.displayOrder).map((row) => ({ label: locale === 'bn' ? row.labelBn : row.labelEn, cells: row.cells })) })),
    related: related.map((item) => publicProduct(item, locale)),
  };
}

function taxonomyDto(entity, locale) {
  const translated = localeName(entity.translations, locale);
  return { id: entity.id, slug: entity.slug, name: translated?.name || '', description: translated?.description || '', imageUrl: entity.image ? mediaPublicUrl(entity.image.storageKey) : entity.logo ? mediaPublicUrl(entity.logo.storageKey) : null };
}

export async function listCategories(locale) {
  const categories = await Category.findAll({ where: { active: true }, include: [translationInclude(CategoryTranslation), { model: MediaAsset, as: 'image', required: false }], order: [['displayOrder', 'ASC']] });
  return categories.map((category) => ({ ...taxonomyDto(category, locale), parentId: category.parentId, displayOrder: category.displayOrder }));
}

export async function getCategory(slug, locale) {
  const category = await Category.findOne({ where: { slug, active: true }, include: [translationInclude(CategoryTranslation), { model: MediaAsset, as: 'image', required: false }, { model: Category, as: 'children', where: { active: true }, required: false, include: [translationInclude(CategoryTranslation)] }] });
  if (!category) throw AppError.notFound('Category not found.');
  return { ...taxonomyDto(category, locale), children: category.children.map((child) => taxonomyDto(child, locale)) };
}

export async function listCollections(locale) {
  const rows = await Collection.findAll({ where: activeWindowWhere(), include: [translationInclude(CollectionTranslation), { model: MediaAsset, as: 'image', required: false }], order: [['displayOrder', 'ASC']] });
  return rows.map((row) => taxonomyDto(row, locale));
}

export async function getCollection(slug, locale) {
  const row = await Collection.findOne({ where: { slug, ...activeWindowWhere() }, include: [translationInclude(CollectionTranslation), { model: MediaAsset, as: 'image', required: false }] });
  if (!row) throw AppError.notFound('Collection not found.');
  return taxonomyDto(row, locale);
}

export async function listBrands(locale) {
  const rows = await Brand.findAll({ where: { active: true }, include: [translationInclude(BrandTranslation), { model: MediaAsset, as: 'logo', required: false }], order: [['displayOrder', 'ASC']] });
  return rows.map((row) => taxonomyDto(row, locale));
}

export async function listAttributes(locale) {
  const rows = await Attribute.findAll({ where: { active: true, filterable: true }, include: [translationInclude(AttributeTranslation), { model: AttributeValue, as: 'values', where: { active: true }, required: false, include: [translationInclude(AttributeValueTranslation)] }], order: [['displayOrder', 'ASC'], [{ model: AttributeValue, as: 'values' }, 'displayOrder', 'ASC']] });
  return rows.map((attribute) => ({ id: attribute.id, key: attribute.key, type: attribute.type, label: localeName(attribute.translations, locale)?.label || attribute.key, values: attribute.values.map((value) => ({ id: value.id, slug: value.slug, label: localeName(value.translations, locale)?.label || value.value, colorHex: value.colorHex })) }));
}

export async function searchSuggestions(query, locale) {
  const term = String(query || '').trim().slice(0, 80);
  if (term.length < 2) return [];
  const rows = await Product.findAll({ where: { status: 'published', visibility: { [Op.in]: ['catalog_search', 'search'] } }, include: [{ model: ProductTranslation, as: 'translations', where: { locale, name: { [Op.like]: `%${term}%` } } }], attributes: ['id', 'slug'], limit: 8, order: [['reviewCount', 'DESC']] });
  return rows.map((row) => ({ id: row.id, slug: row.slug, label: row.translations[0]?.name || row.slug, type: 'product' }));
}

export async function createCategory(payload, actorId = null, request = null) {
  return sequelize.transaction(async (transaction) => {
    if (payload.parentId && !(await Category.findByPk(payload.parentId, { transaction }))) throw AppError.unprocessable('INVALID_PARENT', 'Parent category does not exist.');
    const category = await Category.create({ id: newId(), slug: payload.slug, parentId: payload.parentId || null, imageId: payload.imageId || null, active: payload.active, displayOrder: payload.displayOrder, version: 1 }, { transaction });
    await CategoryTranslation.bulkCreate(['en', 'bn'].map((locale) => ({ id: newId(), categoryId: category.id, locale, ...payload.translations[locale] })), { transaction });
    await recordAudit({ actorId, action: 'catalog.category_create', resourceType: 'category', resourceId: category.id, after: payload, request, transaction });
    return Category.findByPk(category.id, { include: [translationInclude(CategoryTranslation)], transaction });
  });
}

function validatePublish(payload) {
  if (!['published', 'scheduled'].includes(payload.status)) return;
  if (!payload.categoryId) throw AppError.unprocessable('PUBLISH_REQUIREMENTS', 'A published product needs a primary category.', { categoryId: ['Select a primary category.'] });
  if (!payload.media?.some((item) => item.role === 'primary')) throw AppError.unprocessable('PUBLISH_REQUIREMENTS', 'A published product needs a primary image.', { media: ['Choose a primary image.'] });
  if (!payload.variants?.some((variant) => variant.status !== 'archived')) throw AppError.unprocessable('PUBLISH_REQUIREMENTS', 'A published product needs an active purchasable variant.');
  if (payload.status === 'scheduled' && (!payload.publishAt || new Date(payload.publishAt) <= new Date())) throw AppError.unprocessable('INVALID_PUBLISH_SCHEDULE', 'Choose a future publication time for a scheduled product.');
}

export async function createProduct(payload, actorId = null, request = null) {
  validatePublish(payload);
  return sequelize.transaction(async (transaction) => {
    if (payload.categoryId && !(await Category.findByPk(payload.categoryId, { transaction }))) throw AppError.unprocessable('INVALID_CATEGORY', 'Selected category does not exist.');
    if (payload.brandId && !(await Brand.findByPk(payload.brandId, { transaction }))) throw AppError.unprocessable('INVALID_BRAND', 'Selected brand does not exist.');
    if (payload.categoryIds?.length && await Category.count({ where: { id: { [Op.in]: [...new Set(payload.categoryIds)] } }, transaction }) !== new Set(payload.categoryIds).size) throw AppError.unprocessable('INVALID_CATEGORY', 'One or more selected categories do not exist.');
    if (payload.collectionIds?.length && await Collection.count({ where: { id: { [Op.in]: [...new Set(payload.collectionIds)] } }, transaction }) !== new Set(payload.collectionIds).size) throw AppError.unprocessable('INVALID_COLLECTION', 'One or more selected collections do not exist.');
    if (payload.attributes?.length && await Attribute.count({ where: { id: { [Op.in]: [...new Set(payload.attributes.map((item) => item.attributeId))] } }, transaction }) !== new Set(payload.attributes.map((item) => item.attributeId)).size) throw AppError.unprocessable('INVALID_ATTRIBUTE', 'One or more selected attributes do not exist.');
    const attributeValueIds = [...new Set(payload.variants.flatMap((variant) => variant.attributeValueIds || []))];
    if (attributeValueIds.length && await AttributeValue.count({ where: { id: { [Op.in]: attributeValueIds }, active: true }, transaction }) !== attributeValueIds.length) throw AppError.unprocessable('INVALID_ATTRIBUTE_VALUE', 'One or more selected attribute values do not exist.');
    if (payload.media?.length && await MediaAsset.count({ where: { id: { [Op.in]: [...new Set(payload.media.map((item) => item.mediaId))] }, status: 'ready', privacy: 'public' }, transaction }) !== new Set(payload.media.map((item) => item.mediaId)).size) throw AppError.unprocessable('INVALID_MEDIA', 'Every product media asset must be public and ready.');
    const location = await StockLocation.findOne({ where: { active: true }, order: [['createdAt', 'ASC']], transaction, lock: transaction.LOCK.SHARE });
    if (!location) throw AppError.unprocessable('STOCK_LOCATION_REQUIRED', 'Create an active stock location before creating products.');
    const product = await Product.create({ id: newId(), slug: payload.slug, categoryId: payload.categoryId || null, brandId: payload.brandId || null, type: payload.variants.length > 1 ? 'variable' : payload.type, status: payload.status, featured: payload.featured, visibility: payload.visibility || 'catalog_search', taxClass: payload.taxClass || 'standard', shippingProfile: payload.shippingProfile || null, publishAt: payload.status === 'scheduled' ? new Date(payload.publishAt) : null, publishedAt: payload.status === 'published' ? new Date() : null, version: 1 }, { transaction });
    await ProductTranslation.bulkCreate(['en', 'bn'].map((locale) => ({ id: newId(), productId: product.id, locale, ...payload.translations[locale] })), { transaction });
    const variantIdBySku = new Map();
    for (const [index, item] of payload.variants.entries()) {
      const variant = await ProductVariant.create({ id: newId(), productId: product.id, sku: item.sku, barcode: item.barcode || null, title: item.title, attributes: item.attributes, combinationSignature: Object.entries(item.attributes).sort().map(([key, value]) => `${key}:${value}`).join('|'), regularPrice: item.regularPrice, salePrice: item.salePrice || null, costPrice: item.costPrice || null, saleStartsAt: item.saleStartsAt || null, saleEndsAt: item.saleEndsAt || null, stockPolicy: item.stockPolicy, preorderAvailableAt: item.preorderAvailableAt || null, preorderMessage: item.preorderMessage || null, weightGrams: item.weightGrams ?? null, dimensions: item.dimensions || null, status: item.status || 'active', active: (item.status || 'active') === 'active', isDefault: item.isDefault || (index === 0 && !payload.variants.some((value) => value.isDefault)), version: 1 }, { transaction });
      variantIdBySku.set(item.sku.toLocaleLowerCase('en'), variant.id);
      await InventoryLevel.create({ id: newId(), variantId: variant.id, locationId: location.id, onHand: item.stock, reserved: 0, lowStockThreshold: item.lowStockThreshold, version: 1 }, { transaction });
      if (item.stock) await InventoryMovement.create({ id: newId(), variantId: variant.id, locationId: location.id, actorId, quantityDelta: item.stock, reservedDelta: 0, onHandBefore: 0, balanceAfter: item.stock, reservedAfter: 0, reason: 'initial_stock', correlationId: `product:${product.id}:variant:${variant.id}` }, { transaction });
      if (item.attributeValueIds?.length) await variant.setAttributeValues(item.attributeValueIds, { transaction });
    }
    if (payload.categoryIds?.length || payload.categoryId) await product.setCategories([...new Set([payload.categoryId, ...(payload.categoryIds || [])].filter(Boolean))], { transaction });
    if (payload.collectionIds?.length) await product.setCollections([...new Set(payload.collectionIds)], { transaction });
    if (payload.attributes?.length) await ProductAttribute.bulkCreate(payload.attributes.map((item, index) => ({ id: newId(), productId: product.id, attributeId: item.attributeId, variation: item.variation, visible: item.visible, displayOrder: item.displayOrder ?? index })), { transaction });
    if (payload.media?.some((item) => item.variantSku && !variantIdBySku.has(item.variantSku.toLocaleLowerCase('en')))) throw AppError.unprocessable('INVALID_VARIANT_MEDIA', 'Variant media references an unknown SKU.');
    if (payload.media?.length) await ProductMedia.bulkCreate(payload.media.map((item, index) => ({ id: newId(), productId: product.id, variantId: item.variantSku ? variantIdBySku.get(item.variantSku.toLocaleLowerCase('en')) || null : null, mediaId: item.mediaId, role: item.role, displayOrder: item.displayOrder ?? index, altEn: item.altEn || null, altBn: item.altBn || null })), { transaction });
    await recordAudit({ actorId, action: 'catalog.product_create', resourceType: 'product', resourceId: product.id, after: { ...payload, variants: payload.variants.map(({ costPrice: _costPrice, ...variant }) => variant) }, request, transaction });
    return Product.findByPk(product.id, { include: publicProductInclude, transaction });
  });
}
