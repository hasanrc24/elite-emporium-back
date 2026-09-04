import { Model } from 'sequelize';
import { DataTypes, initializeModel, optimisticVersion, primaryId } from './shared.js';

/** @type {any} */
export class MediaAsset extends Model {}
initializeModel(MediaAsset, {
  id: primaryId(), storageKey: { type: DataTypes.STRING(500), allowNull: false, unique: true }, originalName: { type: DataTypes.STRING(255), allowNull: false }, kind: { type: DataTypes.ENUM('image', 'document'), allowNull: false }, mimeType: { type: DataTypes.STRING(120), allowNull: false }, byteSize: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false }, width: DataTypes.INTEGER.UNSIGNED, height: DataTypes.INTEGER.UNSIGNED, checksum: { type: DataTypes.CHAR(64), allowNull: false }, privacy: { type: DataTypes.ENUM('public', 'private'), allowNull: false, defaultValue: 'public' }, status: { type: DataTypes.ENUM('pending', 'processing', 'ready', 'failed', 'archived'), allowNull: false, defaultValue: 'pending' }, altText: DataTypes.STRING(500), metadata: DataTypes.JSON, deletedAt: DataTypes.DATE,
}, { modelName: 'MediaAsset', tableName: 'media_assets', paranoid: true });

/** @type {any} */
export class Category extends Model {}
initializeModel(Category, { id: primaryId(), slug: { type: DataTypes.STRING(160), allowNull: false, unique: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'Category', tableName: 'categories', paranoid: true });
/** @type {any} */
export class CategoryTranslation extends Model {}
initializeModel(CategoryTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, name: { type: DataTypes.STRING(180), allowNull: false }, description: DataTypes.TEXT, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500) }, { modelName: 'CategoryTranslation', tableName: 'category_translations', indexes: [{ unique: true, fields: ['categoryId', 'locale'] }] });

/** @type {any} */
export class Collection extends Model {}
initializeModel(Collection, { id: primaryId(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, startsAt: DataTypes.DATE, endsAt: DataTypes.DATE, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'Collection', tableName: 'collections', paranoid: true });
/** @type {any} */
export class CollectionTranslation extends Model {}
initializeModel(CollectionTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, name: { type: DataTypes.STRING(180), allowNull: false }, description: DataTypes.TEXT, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500) }, { modelName: 'CollectionTranslation', tableName: 'collection_translations', indexes: [{ unique: true, fields: ['collectionId', 'locale'] }] });

/** @type {any} */
export class Brand extends Model {}
initializeModel(Brand, { id: primaryId(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'Brand', tableName: 'brands', paranoid: true });
/** @type {any} */
export class BrandTranslation extends Model {}
initializeModel(BrandTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, name: { type: DataTypes.STRING(180), allowNull: false }, description: DataTypes.TEXT, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500) }, { modelName: 'BrandTranslation', tableName: 'brand_translations', indexes: [{ unique: true, fields: ['brandId', 'locale'] }] });

/** @type {any} */
export class Attribute extends Model {}
initializeModel(Attribute, { id: primaryId(), key: { type: DataTypes.STRING(100), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('select', 'color', 'text'), allowNull: false }, filterable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, variationCapable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'Attribute', tableName: 'attributes', paranoid: true });
/** @type {any} */
export class AttributeTranslation extends Model {}
initializeModel(AttributeTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, label: { type: DataTypes.STRING(160), allowNull: false } }, { modelName: 'AttributeTranslation', tableName: 'attribute_translations', indexes: [{ unique: true, fields: ['attributeId', 'locale'] }] });
/** @type {any} */
export class AttributeValue extends Model {}
initializeModel(AttributeValue, { id: primaryId(), slug: { type: DataTypes.STRING(120), allowNull: false }, value: { type: DataTypes.STRING(180), allowNull: false }, colorHex: DataTypes.STRING(7), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'AttributeValue', tableName: 'attribute_values', paranoid: true, indexes: [{ unique: true, fields: ['attributeId', 'slug'] }] });
/** @type {any} */
export class AttributeValueTranslation extends Model {}
initializeModel(AttributeValueTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, label: { type: DataTypes.STRING(160), allowNull: false } }, { modelName: 'AttributeValueTranslation', tableName: 'attribute_value_translations', indexes: [{ unique: true, fields: ['valueId', 'locale'] }] });

/** @type {any} */
export class Product extends Model {}
initializeModel(Product, { id: primaryId(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('simple', 'variable'), allowNull: false, defaultValue: 'simple' }, status: { type: DataTypes.ENUM('draft', 'scheduled', 'published', 'archived'), allowNull: false, defaultValue: 'draft' }, featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, visibility: { type: DataTypes.ENUM('catalog_search', 'catalog', 'search', 'hidden'), allowNull: false, defaultValue: 'catalog_search' }, taxClass: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'standard' }, shippingProfile: DataTypes.JSON, canonicalUrl: DataTypes.STRING(500), reviewAverage: { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 }, reviewCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: optimisticVersion(), publishAt: DataTypes.DATE, publishedAt: DataTypes.DATE, deletedAt: DataTypes.DATE }, { modelName: 'Product', tableName: 'products', paranoid: true });
/** @type {any} */
export class ProductTranslation extends Model {}
initializeModel(ProductTranslation, { id: primaryId(), locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false }, name: { type: DataTypes.STRING(220), allowNull: false }, shortDescription: DataTypes.TEXT, description: DataTypes.TEXT('long'), careText: DataTypes.TEXT, materialText: DataTypes.TEXT, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500) }, { modelName: 'ProductTranslation', tableName: 'product_translations', indexes: [{ unique: true, fields: ['productId', 'locale'] }] });
/** @type {any} */
export class ProductVariant extends Model {}
initializeModel(ProductVariant, { id: primaryId(), sku: { type: DataTypes.STRING(100), allowNull: false, unique: true }, barcode: { type: DataTypes.STRING(100), unique: true }, title: { type: DataTypes.STRING(180), allowNull: false }, attributes: { type: DataTypes.JSON, allowNull: false, defaultValue: {} }, combinationSignature: DataTypes.STRING(500), regularPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false }, salePrice: DataTypes.DECIMAL(12, 2), costPrice: DataTypes.DECIMAL(12, 2), saleStartsAt: DataTypes.DATE, saleEndsAt: DataTypes.DATE, stockPolicy: { type: DataTypes.ENUM('deny', 'allow_backorder', 'preorder'), allowNull: false, defaultValue: 'deny' }, preorderAvailableAt: DataTypes.DATE, preorderMessage: DataTypes.STRING(255), weightGrams: DataTypes.INTEGER.UNSIGNED, dimensions: DataTypes.JSON, status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'ProductVariant', tableName: 'product_variants', paranoid: true });
/** @type {any} */
export class ProductMedia extends Model {}
initializeModel(ProductMedia, { id: primaryId(), role: { type: DataTypes.ENUM('primary', 'gallery', 'swatch', 'size_chart'), allowNull: false, defaultValue: 'gallery' }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, altEn: DataTypes.STRING(500), altBn: DataTypes.STRING(500) }, { modelName: 'ProductMedia', tableName: 'product_media' });
/** @type {any} */
export class ProductAttribute extends Model {}
initializeModel(ProductAttribute, { id: primaryId(), variation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 } }, { modelName: 'ProductAttribute', tableName: 'product_attributes' });
/** @type {any} */
export class ProductTag extends Model {}
initializeModel(ProductTag, { id: primaryId(), tag: { type: DataTypes.STRING(100), allowNull: false } }, { modelName: 'ProductTag', tableName: 'product_tags' });
/** @type {any} */
export class SizeChart extends Model {}
initializeModel(SizeChart, { id: primaryId(), name: { type: DataTypes.STRING(160), allowNull: false }, units: { type: DataTypes.ENUM('cm', 'in'), allowNull: false, defaultValue: 'cm' }, titleEn: { type: DataTypes.STRING(180), allowNull: false }, titleBn: { type: DataTypes.STRING(180), allowNull: false }, version: optimisticVersion(), deletedAt: DataTypes.DATE }, { modelName: 'SizeChart', tableName: 'size_charts', paranoid: true });
/** @type {any} */
export class SizeChartRow extends Model {}
initializeModel(SizeChartRow, { id: primaryId(), labelEn: { type: DataTypes.STRING(120), allowNull: false }, labelBn: { type: DataTypes.STRING(120), allowNull: false }, cells: { type: DataTypes.JSON, allowNull: false }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 } }, { modelName: 'SizeChartRow', tableName: 'size_chart_rows' });
/** @type {any} */
export class RelatedProduct extends Model {}
initializeModel(RelatedProduct, { relation: { type: DataTypes.ENUM('related', 'upsell', 'cross_sell'), allowNull: false }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 } }, { modelName: 'RelatedProduct', tableName: 'related_products', timestamps: true });
/** @type {any} */
export class Redirect extends Model {}
initializeModel(Redirect, { id: primaryId(), sourcePath: { type: DataTypes.STRING(500), allowNull: false, unique: true }, targetPath: { type: DataTypes.STRING(500), allowNull: false }, statusCode: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 301 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true } }, { modelName: 'Redirect', tableName: 'redirects' });

/** @type {any} */
export class StockLocation extends Model {}
initializeModel(StockLocation, { id: primaryId(), code: { type: DataTypes.STRING(60), allowNull: false, unique: true }, name: { type: DataTypes.STRING(160), allowNull: false }, address: DataTypes.JSON, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: optimisticVersion() }, { modelName: 'StockLocation', tableName: 'stock_locations' });
/** @type {any} */
export class InventoryLevel extends Model {}
initializeModel(InventoryLevel, { id: primaryId(), onHand: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, reserved: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, lowStockThreshold: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 3 }, version: optimisticVersion() }, { modelName: 'InventoryLevel', tableName: 'inventory_levels' });
/** @type {any} */
export class InventoryReservation extends Model {}
initializeModel(InventoryReservation, { id: primaryId(), quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, status: { type: DataTypes.ENUM('active', 'converted', 'consumed', 'released', 'expired'), allowNull: false }, expiresAt: { type: DataTypes.DATE, allowNull: false }, releasedAt: DataTypes.DATE, convertedAt: DataTypes.DATE, consumedAt: DataTypes.DATE, idempotencyKey: { type: DataTypes.STRING(150), allowNull: false } }, { modelName: 'InventoryReservation', tableName: 'inventory_reservations' });
/** @type {any} */
export class InventoryMovement extends Model {}
initializeModel(InventoryMovement, { id: primaryId(), quantityDelta: { type: DataTypes.INTEGER, allowNull: false }, reservedDelta: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, onHandBefore: DataTypes.INTEGER.UNSIGNED, balanceAfter: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, reservedAfter: DataTypes.INTEGER.UNSIGNED, reason: { type: DataTypes.STRING(80), allowNull: false }, note: DataTypes.STRING(500), correlationId: DataTypes.STRING(100) }, { modelName: 'InventoryMovement', tableName: 'inventory_movements', updatedAt: false });
