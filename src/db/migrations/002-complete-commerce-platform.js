import { DataTypes } from 'sequelize';

const tableOptions = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };
const id = () => ({ type: DataTypes.CHAR(26), allowNull: false, primaryKey: true });
const ref = (table, allowNull = false, onDelete = allowNull ? 'SET NULL' : 'RESTRICT') => ({
  type: DataTypes.CHAR(26),
  allowNull,
  references: { model: table, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete,
});
const timestamps = (softDelete = false) => ({
  createdAt: { type: DataTypes.DATE(3), allowNull: false },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  ...(softDelete ? { deletedAt: DataTypes.DATE(3) } : {}),
});
const version = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 });
const money = (allowNull = false, defaultValue) => ({ type: DataTypes.DECIMAL(12, 2), allowNull, ...(defaultValue !== undefined ? { defaultValue } : {}) });
const locale = () => ({ type: DataTypes.ENUM('en', 'bn'), allowNull: false });

/**
 * MariaDB/MySQL DDL statements auto-commit, so a failed migration can leave
 * columns and indexes behind even though Umzug does not record the migration.
 * Make additive operations safe to retry without hiding incompatible schema.
 */
function resumableQueryInterface(queryInterface) {
  const addColumn = async (table, column, definition, options) => {
    const columns = await queryInterface.describeTable(table);
    if (Object.hasOwn(columns, column)) return;
    await queryInterface.addColumn(table, column, definition, options);
  };

  const addIndex = async (table, fields, options = {}) => {
    const expectedFields = fields.map((field) => (typeof field === 'string' ? field : field.attribute ?? field.name));
    const indexes = await queryInterface.showIndex(table);
    const exists = indexes.some((index) => {
      if (options.name && index.name === options.name) return true;
      const actualFields = index.fields?.map((field) => field.attribute ?? field.name) ?? [];
      return Boolean(index.unique) === Boolean(options.unique)
        && actualFields.length === expectedFields.length
        && actualFields.every((field, position) => field === expectedFields[position]);
    });
    if (exists) return;
    await queryInterface.addIndex(table, fields, options);
  };

  return new Proxy(queryInterface, {
    get(target, property) {
      if (property === 'addColumn') return addColumn;
      if (property === 'addIndex') return addIndex;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function up({ context }) {
  const queryInterface = resumableQueryInterface(context);
  await queryInterface.createTable('media_assets', {
    id: id(),
    uploaderId: ref('users', true),
    storageKey: { type: DataTypes.STRING(500), allowNull: false, unique: true },
    originalName: { type: DataTypes.STRING(255), allowNull: false },
    kind: { type: DataTypes.ENUM('image', 'document'), allowNull: false },
    mimeType: { type: DataTypes.STRING(120), allowNull: false },
    byteSize: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    width: DataTypes.INTEGER.UNSIGNED,
    height: DataTypes.INTEGER.UNSIGNED,
    checksum: { type: DataTypes.CHAR(64), allowNull: false },
    privacy: { type: DataTypes.ENUM('public', 'private'), allowNull: false, defaultValue: 'public' },
    status: { type: DataTypes.ENUM('pending', 'processing', 'ready', 'failed', 'archived'), allowNull: false, defaultValue: 'pending' },
    altText: DataTypes.STRING(500),
    metadata: DataTypes.JSON,
    ...timestamps(true),
  }, tableOptions);

  await queryInterface.createTable('audit_logs', {
    id: id(),
    actorId: ref('users', true),
    action: { type: DataTypes.STRING(120), allowNull: false },
    resourceType: { type: DataTypes.STRING(100), allowNull: false },
    resourceId: DataTypes.CHAR(26),
    before: DataTypes.JSON,
    after: DataTypes.JSON,
    metadata: DataTypes.JSON,
    requestId: DataTypes.STRING(100),
    ipAddress: DataTypes.STRING(64),
    userAgent: DataTypes.STRING(255),
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
  }, tableOptions);

  await queryInterface.createTable('user_permission_overrides', {
    id: id(), userId: ref('users'), permissionId: ref('permissions'), allow: { type: DataTypes.BOOLEAN, allowNull: false }, reason: { type: DataTypes.STRING(255), allowNull: false }, actorId: ref('users'), ...timestamps(),
  }, { ...tableOptions, uniqueKeys: { user_permission_override_unique: { fields: ['userId', 'permissionId'] } } });
  await queryInterface.createTable('verification_tokens', {
    id: id(), userId: ref('users'), channel: { type: DataTypes.ENUM('phone', 'email'), allowNull: false }, purpose: { type: DataTypes.ENUM('verify', 'identity_change'), allowNull: false }, target: { type: DataTypes.STRING(190), allowNull: false }, tokenHash: { type: DataTypes.CHAR(64), allowNull: false }, expiresAt: { type: DataTypes.DATE(3), allowNull: false }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, sentAt: DataTypes.DATE(3), consumedAt: DataTypes.DATE(3), ...timestamps(),
  }, tableOptions);
  await queryInterface.createTable('password_reset_tokens', {
    id: id(), userId: ref('users'), tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true }, expiresAt: { type: DataTypes.DATE(3), allowNull: false }, consumedAt: DataTypes.DATE(3), requestedIp: DataTypes.STRING(64), requestedUserAgent: DataTypes.STRING(255), ...timestamps(),
  }, tableOptions);
  await queryInterface.createTable('auth_challenges', {
    id: id(), userId: ref('users'), type: { type: DataTypes.ENUM('mfa_login'), allowNull: false }, tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true }, rememberMe: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, expiresAt: { type: DataTypes.DATE(3), allowNull: false }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, consumedAt: DataTypes.DATE(3), userAgent: DataTypes.STRING(255), ipAddress: DataTypes.STRING(64), ...timestamps(),
  }, tableOptions);
  await queryInterface.createTable('mfa_methods', {
    id: id(), userId: ref('users'), type: { type: DataTypes.ENUM('totp'), allowNull: false }, encryptedSecret: { type: DataTypes.TEXT, allowNull: false }, label: DataTypes.STRING(120), confirmedAt: DataTypes.DATE(3), disabledAt: DataTypes.DATE(3), ...timestamps(),
  }, tableOptions);
  await queryInterface.createTable('mfa_recovery_codes', {
    id: id(), methodId: ref('mfa_methods'), codeHash: { type: DataTypes.CHAR(64), allowNull: false }, consumedAt: DataTypes.DATE(3), createdAt: { type: DataTypes.DATE(3), allowNull: false },
  }, tableOptions);
  await queryInterface.createTable('user_addresses', {
    id: id(), userId: ref('users'), label: { type: DataTypes.STRING(80), allowNull: false }, recipientName: { type: DataTypes.STRING(120), allowNull: false }, phone: { type: DataTypes.STRING(20), allowNull: false }, addressLine: { type: DataTypes.STRING(500), allowNull: false }, area: DataTypes.STRING(120), district: DataTypes.STRING(120), division: DataTypes.STRING(120), postcode: DataTypes.STRING(20), landmark: DataTypes.STRING(255), isDefaultShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, isDefaultBilling: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, version: version(), ...timestamps(true),
  }, tableOptions);

  await queryInterface.addColumn('users', 'mustChangePassword', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await queryInterface.addColumn('users', 'riskLevel', { type: DataTypes.ENUM('normal', 'review', 'blocked'), allowNull: false, defaultValue: 'normal' });
  await queryInterface.addColumn('users', 'version', version());
  await queryInterface.addColumn('roles', 'active', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
  await queryInterface.addColumn('roles', 'system', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await queryInterface.addColumn('permissions', 'module', { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'general' });
  await queryInterface.addColumn('role_permissions', 'allow', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });

  await queryInterface.createTable('collections', {
    id: id(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, startsAt: DataTypes.DATE(3), endsAt: DataTypes.DATE(3), imageId: ref('media_assets', true), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: version(), ...timestamps(true),
  }, tableOptions);
  await queryInterface.createTable('collection_translations', {
    id: id(), collectionId: ref('collections'), locale: locale(), name: { type: DataTypes.STRING(180), allowNull: false }, description: DataTypes.TEXT('long'), seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500), ...timestamps(),
  }, { ...tableOptions, uniqueKeys: { collection_locale_unique: { fields: ['collectionId', 'locale'] } } });
  await queryInterface.createTable('brands', {
    id: id(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, logoId: ref('media_assets', true), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: version(), ...timestamps(true),
  }, tableOptions);
  await queryInterface.createTable('brand_translations', {
    id: id(), brandId: ref('brands'), locale: locale(), name: { type: DataTypes.STRING(180), allowNull: false }, description: DataTypes.TEXT, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500), ...timestamps(),
  }, { ...tableOptions, uniqueKeys: { brand_locale_unique: { fields: ['brandId', 'locale'] } } });
  await queryInterface.createTable('attributes', {
    id: id(), key: { type: DataTypes.STRING(100), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('select', 'color', 'text'), allowNull: false }, filterable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, variationCapable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps(true),
  }, tableOptions);
  await queryInterface.createTable('attribute_translations', {
    id: id(), attributeId: ref('attributes'), locale: locale(), label: { type: DataTypes.STRING(160), allowNull: false }, ...timestamps(),
  }, { ...tableOptions, uniqueKeys: { attribute_locale_unique: { fields: ['attributeId', 'locale'] } } });
  await queryInterface.createTable('attribute_values', {
    id: id(), attributeId: ref('attributes'), slug: { type: DataTypes.STRING(120), allowNull: false }, value: { type: DataTypes.STRING(180), allowNull: false }, colorHex: DataTypes.STRING(7), swatchMediaId: ref('media_assets', true), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps(true),
  }, { ...tableOptions, uniqueKeys: { attribute_value_unique: { fields: ['attributeId', 'slug'] } } });
  await queryInterface.createTable('attribute_value_translations', {
    id: id(), valueId: ref('attribute_values'), locale: locale(), label: { type: DataTypes.STRING(160), allowNull: false }, ...timestamps(),
  }, { ...tableOptions, uniqueKeys: { attribute_value_locale_unique: { fields: ['valueId', 'locale'] } } });

  await queryInterface.addColumn('categories', 'parentId', ref('categories', true));
  await queryInterface.addColumn('categories', 'imageId', ref('media_assets', true));
  await queryInterface.addColumn('categories', 'version', version());
  await queryInterface.addColumn('category_translations', 'seoTitle', DataTypes.STRING(255));
  await queryInterface.addColumn('category_translations', 'seoDescription', DataTypes.STRING(500));
  await queryInterface.addColumn('products', 'brandId', ref('brands', true));
  await queryInterface.addColumn('products', 'visibility', { type: DataTypes.ENUM('catalog_search', 'catalog', 'search', 'hidden'), allowNull: false, defaultValue: 'catalog_search' });
  await queryInterface.addColumn('products', 'publishAt', DataTypes.DATE(3));
  await queryInterface.addColumn('products', 'canonicalUrl', DataTypes.STRING(500));
  await queryInterface.addColumn('products', 'taxClass', { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'standard' });
  await queryInterface.addColumn('products', 'shippingProfile', DataTypes.JSON);
  await queryInterface.addColumn('products', 'reviewAverage', { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('products', 'reviewCount', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('product_translations', 'careText', DataTypes.TEXT);
  await queryInterface.addColumn('product_translations', 'materialText', DataTypes.TEXT);
  await queryInterface.addColumn('product_translations', 'seoTitle', DataTypes.STRING(255));
  await queryInterface.addColumn('product_translations', 'seoDescription', DataTypes.STRING(500));
  await queryInterface.addColumn('product_variants', 'barcode', { type: DataTypes.STRING(100), unique: true });
  await queryInterface.addColumn('product_variants', 'status', { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' });
  await queryInterface.addColumn('product_variants', 'saleStartsAt', DataTypes.DATE(3));
  await queryInterface.addColumn('product_variants', 'saleEndsAt', DataTypes.DATE(3));
  await queryInterface.addColumn('product_variants', 'preorderAvailableAt', DataTypes.DATE(3));
  await queryInterface.addColumn('product_variants', 'preorderMessage', DataTypes.STRING(255));
  await queryInterface.addColumn('product_variants', 'weightGrams', DataTypes.INTEGER.UNSIGNED);
  await queryInterface.addColumn('product_variants', 'dimensions', DataTypes.JSON);
  await queryInterface.addColumn('product_variants', 'combinationSignature', { type: DataTypes.STRING(500) });

  await queryInterface.createTable('product_categories', { productId: ref('products'), categoryId: ref('categories'), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { product_category_unique: { fields: ['productId', 'categoryId'] } } });
  await queryInterface.createTable('product_collections', { productId: ref('products'), collectionId: ref('collections'), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { product_collection_unique: { fields: ['productId', 'collectionId'] } } });
  await queryInterface.createTable('product_tags', { id: id(), productId: ref('products'), tag: { type: DataTypes.STRING(100), allowNull: false }, ...timestamps() }, { ...tableOptions, uniqueKeys: { product_tag_unique: { fields: ['productId', 'tag'] } } });
  await queryInterface.createTable('product_attributes', { id: id(), productId: ref('products'), attributeId: ref('attributes'), variation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { product_attribute_unique: { fields: ['productId', 'attributeId'] } } });
  await queryInterface.createTable('product_attribute_values', { productAttributeId: ref('product_attributes'), valueId: ref('attribute_values'), ...timestamps() }, { ...tableOptions, uniqueKeys: { product_attribute_value_unique: { fields: ['productAttributeId', 'valueId'] } } });
  await queryInterface.createTable('variant_attribute_values', { variantId: ref('product_variants'), attributeId: ref('attributes'), valueId: ref('attribute_values'), ...timestamps() }, { ...tableOptions, uniqueKeys: { variant_attribute_unique: { fields: ['variantId', 'attributeId'] } } });
  await queryInterface.createTable('product_media', { id: id(), productId: ref('products'), variantId: ref('product_variants', true), mediaId: ref('media_assets'), role: { type: DataTypes.ENUM('primary', 'gallery', 'swatch', 'size_chart'), allowNull: false, defaultValue: 'gallery' }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, altEn: DataTypes.STRING(500), altBn: DataTypes.STRING(500), ...timestamps() }, tableOptions);
  await queryInterface.createTable('size_charts', { id: id(), name: { type: DataTypes.STRING(160), allowNull: false }, units: { type: DataTypes.ENUM('cm', 'in'), allowNull: false, defaultValue: 'cm' }, titleEn: { type: DataTypes.STRING(180), allowNull: false }, titleBn: { type: DataTypes.STRING(180), allowNull: false }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('size_chart_rows', { id: id(), chartId: ref('size_charts'), labelEn: { type: DataTypes.STRING(120), allowNull: false }, labelBn: { type: DataTypes.STRING(120), allowNull: false }, cells: { type: DataTypes.JSON, allowNull: false }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, tableOptions);
  await queryInterface.createTable('product_size_charts', { productId: ref('products'), chartId: ref('size_charts'), ...timestamps() }, { ...tableOptions, uniqueKeys: { product_size_chart_unique: { fields: ['productId', 'chartId'] } } });
  await queryInterface.createTable('related_products', { sourceProductId: ref('products'), targetProductId: ref('products'), relation: { type: DataTypes.ENUM('related', 'upsell', 'cross_sell'), allowNull: false }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { related_product_unique: { fields: ['sourceProductId', 'targetProductId', 'relation'] } } });
  await queryInterface.createTable('redirects', { id: id(), sourcePath: { type: DataTypes.STRING(500), allowNull: false, unique: true }, targetPath: { type: DataTypes.STRING(500), allowNull: false }, statusCode: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 301 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...timestamps() }, tableOptions);

  await queryInterface.createTable('stock_locations', { id: id(), code: { type: DataTypes.STRING(60), allowNull: false, unique: true }, name: { type: DataTypes.STRING(160), allowNull: false }, address: DataTypes.JSON, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps() }, tableOptions);
  await queryInterface.addColumn('inventory_levels', 'locationId', ref('stock_locations', true));
  const inventoryIndexes = await queryInterface.showIndex('inventory_levels');
  const legacyVariantUnique = inventoryIndexes.find((index) => index.unique && index.fields?.length === 1 && index.fields[0]?.attribute === 'variantId');
  // The replacement must exist before the legacy index is removed because the
  // variant foreign key requires an index whose left-most column is variantId.
  await queryInterface.addIndex('inventory_levels', ['variantId', 'locationId'], { unique: true, name: 'inventory_levels_variant_location_unique' });
  if (legacyVariantUnique) await queryInterface.removeIndex('inventory_levels', legacyVariantUnique.name);
  await queryInterface.createTable('inventory_reservations', { id: id(), variantId: ref('product_variants'), locationId: ref('stock_locations'), cartId: ref('carts', true), orderId: ref('orders', true), quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, status: { type: DataTypes.ENUM('active', 'converted', 'consumed', 'released', 'expired'), allowNull: false }, expiresAt: { type: DataTypes.DATE(3), allowNull: false }, releasedAt: DataTypes.DATE(3), convertedAt: DataTypes.DATE(3), consumedAt: DataTypes.DATE(3), idempotencyKey: { type: DataTypes.STRING(150), allowNull: false }, ...timestamps() }, { ...tableOptions, uniqueKeys: { reservation_idempotency_unique: { fields: ['idempotencyKey', 'variantId', 'locationId'] } } });
  await queryInterface.addColumn('inventory_movements', 'locationId', ref('stock_locations', true));
  await queryInterface.addColumn('inventory_movements', 'reservedDelta', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('inventory_movements', 'onHandBefore', DataTypes.INTEGER.UNSIGNED);
  await queryInterface.addColumn('inventory_movements', 'reservedAfter', DataTypes.INTEGER.UNSIGNED);
  await queryInterface.addColumn('inventory_movements', 'actorId', ref('users', true));
  await queryInterface.addColumn('inventory_movements', 'note', DataTypes.STRING(500));

  await queryInterface.createTable('coupons', { id: id(), code: { type: DataTypes.STRING(80), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('percentage', 'fixed_cart', 'fixed_item', 'free_delivery'), allowNull: false }, amount: money(false, 0), startsAt: DataTypes.DATE(3), endsAt: DataTypes.DATE(3), minimumSpend: money(true), maximumSpend: money(true), usageLimit: DataTypes.INTEGER.UNSIGNED, perCustomerLimit: DataTypes.INTEGER.UNSIGNED, perItemLimit: DataTypes.INTEGER.UNSIGNED, includeSaleItems: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, firstOrderOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, stackable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, allowedZones: DataTypes.JSON, allowedPayments: DataTypes.JSON, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.addColumn('cart_items', 'unitPriceSnapshot', money(true));
  await queryInterface.addColumn('cart_items', 'metadata', DataTypes.JSON);
  for (const [table, target] of [['coupon_products', 'products'], ['coupon_product_exclusions', 'products'], ['coupon_categories', 'categories'], ['coupon_category_exclusions', 'categories']]) {
    const targetKey = `${target === 'products' ? 'product' : 'category'}Id`;
    await queryInterface.createTable(table, { couponId: ref('coupons'), [targetKey]: ref(target), ...timestamps() }, { ...tableOptions, uniqueKeys: { [`${table}_unique`]: { fields: ['couponId', targetKey] } } });
  }
  await queryInterface.createTable('cart_coupons', { id: id(), cartId: ref('carts'), couponId: ref('coupons'), applicationOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { cart_coupon_unique: { fields: ['cartId', 'couponId'] } } });
  await queryInterface.createTable('coupon_usages', { id: id(), couponId: ref('coupons'), orderId: ref('orders'), userId: ref('users', true), customerPhone: DataTypes.STRING(20), amount: money(false, 0), status: { type: DataTypes.ENUM('reserved', 'consumed', 'released', 'reversed'), allowNull: false }, ...timestamps() }, tableOptions);
  await queryInterface.createTable('checkout_quotes', { id: id(), cartId: ref('carts'), userId: ref('users', true), requestHash: { type: DataTypes.CHAR(64), allowNull: false }, payload: { type: DataTypes.JSON, allowNull: false }, totals: { type: DataTypes.JSON, allowNull: false }, expiresAt: { type: DataTypes.DATE(3), allowNull: false }, consumedAt: DataTypes.DATE(3), ...timestamps() }, tableOptions);

  await queryInterface.addColumn('orders', 'currency', { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'BDT' });
  await queryInterface.addColumn('orders', 'placedAt', DataTypes.DATE(3));
  await queryInterface.addColumn('orders', 'completedAt', DataTypes.DATE(3));
  await queryInterface.addColumn('orders', 'metadata', DataTypes.JSON);
  await queryInterface.addColumn('order_items', 'regularPrice', money(true));
  await queryInterface.addColumn('order_items', 'salePrice', money(true));
  await queryInterface.addColumn('order_items', 'discountTotal', money(false, 0));
  await queryInterface.addColumn('order_items', 'taxTotal', money(false, 0));
  await queryInterface.addColumn('order_items', 'fulfilledQuantity', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('order_items', 'returnedQuantity', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('order_events', 'actorId', ref('users', true));
  await queryInterface.addColumn('order_events', 'fromStatus', DataTypes.STRING(60));
  await queryInterface.addColumn('order_events', 'toStatus', DataTypes.STRING(60));
  await queryInterface.createTable('order_addresses', { id: id(), orderId: ref('orders'), type: { type: DataTypes.ENUM('shipping', 'billing'), allowNull: false }, recipientName: { type: DataTypes.STRING(120), allowNull: false }, phone: { type: DataTypes.STRING(20), allowNull: false }, addressLine: { type: DataTypes.STRING(500), allowNull: false }, area: DataTypes.STRING(120), district: DataTypes.STRING(120), division: DataTypes.STRING(120), postcode: DataTypes.STRING(20), landmark: DataTypes.STRING(255), deliveryCode: DataTypes.STRING(60), snapshot: DataTypes.JSON, ...timestamps() }, { ...tableOptions, uniqueKeys: { order_address_type_unique: { fields: ['orderId', 'type'] } } });
  await queryInterface.createTable('order_notes', { id: id(), orderId: ref('orders'), actorId: ref('users', true), visibility: { type: DataTypes.ENUM('internal', 'customer'), allowNull: false, defaultValue: 'internal' }, message: { type: DataTypes.TEXT, allowNull: false }, createdAt: { type: DataTypes.DATE(3), allowNull: false } }, tableOptions);
  await queryInterface.createTable('payments', { id: id(), orderId: ref('orders'), method: { type: DataTypes.ENUM('cod', 'bkash'), allowNull: false }, provider: DataTypes.STRING(80), amount: money(), currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'BDT' }, status: { type: DataTypes.ENUM('unpaid', 'pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'), allowNull: false }, providerTransactionId: { type: DataTypes.STRING(190), unique: true }, reference: DataTypes.STRING(190), paidAt: DataTypes.DATE(3), failedAt: DataTypes.DATE(3), cancelledAt: DataTypes.DATE(3), version: version(), metadata: DataTypes.JSON, ...timestamps() }, tableOptions);
  await queryInterface.createTable('payment_attempts', { id: id(), paymentId: ref('payments'), idempotencyKey: { type: DataTypes.STRING(150), allowNull: false }, recoveryTokenHash: { type: DataTypes.CHAR(64), allowNull: false }, providerPaymentId: { type: DataTypes.STRING(190), unique: true }, amount: money(), status: { type: DataTypes.ENUM('created', 'redirected', 'executing', 'succeeded', 'failed', 'cancelled', 'expired'), allowNull: false }, redirectUrl: DataTypes.STRING(1000), requestMetadata: DataTypes.JSON, responseMetadata: DataTypes.JSON, callbackState: DataTypes.JSON, expiresAt: DataTypes.DATE(3), ...timestamps() }, { ...tableOptions, uniqueKeys: { payment_attempt_idempotency_unique: { fields: ['paymentId', 'idempotencyKey'] } } });
  await queryInterface.createTable('refunds', { id: id(), paymentId: ref('payments'), orderId: ref('orders'), amount: money(), reason: { type: DataTypes.STRING(500), allowNull: false }, method: { type: DataTypes.ENUM('manual', 'bkash'), allowNull: false }, providerRefundId: { type: DataTypes.STRING(190), unique: true }, status: { type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'cancelled'), allowNull: false }, actorId: ref('users'), completedAt: DataTypes.DATE(3), idempotencyKey: { type: DataTypes.STRING(150), allowNull: false }, metadata: DataTypes.JSON, ...timestamps() }, { ...tableOptions, uniqueKeys: { refund_idempotency_unique: { fields: ['paymentId', 'idempotencyKey'] } } });

  await queryInterface.createTable('shipping_zones', { id: id(), code: { type: DataTypes.STRING(60), allowNull: false, unique: true }, nameEn: { type: DataTypes.STRING(160), allowNull: false }, nameBn: { type: DataTypes.STRING(160), allowNull: false }, matchMode: { type: DataTypes.ENUM('selector', 'structured'), allowNull: false, defaultValue: 'selector' }, rules: DataTypes.JSON, priority: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('shipping_methods', { id: id(), zoneId: ref('shipping_zones'), code: { type: DataTypes.STRING(60), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('flat_rate', 'free', 'courier'), allowNull: false, defaultValue: 'flat_rate' }, labelEn: { type: DataTypes.STRING(160), allowNull: false }, labelBn: { type: DataTypes.STRING(160), allowNull: false }, flatRate: money(false, 0), freeThreshold: money(true), allowedPayments: DataTypes.JSON, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('shipments', { id: id(), orderId: ref('orders'), provider: DataTypes.STRING(100), courierName: DataTypes.STRING(160), consignmentId: DataTypes.STRING(190), trackingUrl: DataTypes.STRING(1000), fee: money(true), status: { type: DataTypes.ENUM('draft', 'created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled', 'failed'), allowNull: false, defaultValue: 'draft' }, labelMediaId: ref('media_assets', true), shippedAt: DataTypes.DATE(3), deliveredAt: DataTypes.DATE(3), version: version(), ...timestamps() }, tableOptions);
  await queryInterface.createTable('shipment_events', { id: id(), shipmentId: ref('shipments'), type: { type: DataTypes.STRING(100), allowNull: false }, message: { type: DataTypes.STRING(500), allowNull: false }, providerEventId: DataTypes.STRING(190), metadata: DataTypes.JSON, createdAt: { type: DataTypes.DATE(3), allowNull: false } }, tableOptions);

  await queryInterface.createTable('wishlists', { id: id(), userId: ref('users', true), tokenHash: { type: DataTypes.CHAR(64), unique: true }, status: { type: DataTypes.ENUM('active', 'merged', 'expired'), allowNull: false, defaultValue: 'active' }, expiresAt: DataTypes.DATE(3), ...timestamps() }, tableOptions);
  await queryInterface.createTable('wishlist_items', { id: id(), wishlistId: ref('wishlists'), productId: ref('products'), variantId: ref('product_variants', true), itemKey: { type: DataTypes.STRING(80), allowNull: false }, ...timestamps() }, { ...tableOptions, uniqueKeys: { wishlist_item_key_unique: { fields: ['wishlistId', 'itemKey'] } } });
  await queryInterface.createTable('reviews', { id: id(), productId: ref('products'), userId: ref('users'), orderItemId: ref('order_items'), rating: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, title: DataTypes.STRING(180), body: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'spam'), allowNull: false, defaultValue: 'pending' }, verifiedPurchase: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, moderationReason: DataTypes.STRING(500), moderatedBy: ref('users', true), moderatedAt: DataTypes.DATE(3), version: version(), ...timestamps(true) }, { ...tableOptions, uniqueKeys: { review_order_item_unique: { fields: ['orderItemId'] } } });
  await queryInterface.addColumn('reviews', 'staffResponse', DataTypes.TEXT);
  await queryInterface.addColumn('reviews', 'respondedAt', DataTypes.DATE(3));
  await queryInterface.createTable('review_media', { reviewId: ref('reviews'), mediaId: ref('media_assets'), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { review_media_unique: { fields: ['reviewId', 'mediaId'] } } });
  await queryInterface.createTable('return_requests', { id: id(), orderId: ref('orders'), userId: ref('users', true), type: { type: DataTypes.ENUM('return', 'exchange'), allowNull: false }, status: { type: DataTypes.ENUM('requested', 'under_review', 'approved', 'rejected', 'in_transit', 'received', 'completed', 'cancelled'), allowNull: false }, reason: { type: DataTypes.STRING(255), allowNull: false }, customerNote: DataTypes.TEXT, resolution: { type: DataTypes.ENUM('refund', 'exchange'), allowNull: false }, refundAmount: money(true), replacementOrderId: ref('orders', true), requestedAt: { type: DataTypes.DATE(3), allowNull: false }, approvedAt: DataTypes.DATE(3), receivedAt: DataTypes.DATE(3), completedAt: DataTypes.DATE(3), policySnapshot: DataTypes.JSON, version: version(), ...timestamps() }, tableOptions);
  await queryInterface.createTable('return_items', { id: id(), returnId: ref('return_requests'), orderItemId: ref('order_items'), quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, reason: { type: DataTypes.STRING(255), allowNull: false }, condition: DataTypes.STRING(120), resolution: { type: DataTypes.ENUM('refund', 'exchange'), allowNull: false }, restock: DataTypes.BOOLEAN, inspectionNote: DataTypes.STRING(500), ...timestamps() }, { ...tableOptions, uniqueKeys: { return_order_item_unique: { fields: ['returnId', 'orderItemId'] } } });
  await queryInterface.createTable('return_events', { id: id(), returnId: ref('return_requests'), actorId: ref('users', true), type: { type: DataTypes.STRING(100), allowNull: false }, message: { type: DataTypes.STRING(500), allowNull: false }, public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, metadata: DataTypes.JSON, createdAt: { type: DataTypes.DATE(3), allowNull: false } }, tableOptions);
  await queryInterface.createTable('return_media', { returnId: ref('return_requests'), mediaId: ref('media_assets'), displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, ...timestamps() }, { ...tableOptions, uniqueKeys: { return_media_unique: { fields: ['returnId', 'mediaId'] } } });

  await queryInterface.createTable('pages', { id: id(), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, template: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'standard' }, status: { type: DataTypes.ENUM('draft', 'scheduled', 'published', 'archived'), allowNull: false }, publishAt: DataTypes.DATE(3), version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('page_translations', { id: id(), pageId: ref('pages'), locale: locale(), title: { type: DataTypes.STRING(255), allowNull: false }, excerpt: DataTypes.TEXT, blocks: { type: DataTypes.JSON, allowNull: false }, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500), ...timestamps() }, { ...tableOptions, uniqueKeys: { page_locale_unique: { fields: ['pageId', 'locale'] } } });
  await queryInterface.createTable('post_categories', { id: id(), slug: { type: DataTypes.STRING(160), allowNull: false, unique: true }, nameEn: { type: DataTypes.STRING(180), allowNull: false }, nameBn: { type: DataTypes.STRING(180), allowNull: false }, ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('posts', { id: id(), categoryId: ref('post_categories', true), authorId: ref('users', true), slug: { type: DataTypes.STRING(180), allowNull: false, unique: true }, type: { type: DataTypes.ENUM('blog', 'lookbook'), allowNull: false, defaultValue: 'blog' }, coverMediaId: ref('media_assets', true), status: { type: DataTypes.ENUM('draft', 'scheduled', 'published', 'archived'), allowNull: false }, publishAt: DataTypes.DATE(3), version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('post_translations', { id: id(), postId: ref('posts'), locale: locale(), title: { type: DataTypes.STRING(255), allowNull: false }, excerpt: DataTypes.TEXT, blocks: { type: DataTypes.JSON, allowNull: false }, seoTitle: DataTypes.STRING(255), seoDescription: DataTypes.STRING(500), ...timestamps() }, { ...tableOptions, uniqueKeys: { post_locale_unique: { fields: ['postId', 'locale'] } } });
  await queryInterface.createTable('menus', { id: id(), location: { type: DataTypes.STRING(80), allowNull: false, unique: true }, name: { type: DataTypes.STRING(160), allowNull: false }, status: { type: DataTypes.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' }, version: version(), ...timestamps() }, tableOptions);
  await queryInterface.createTable('menu_items', { id: id(), menuId: ref('menus'), parentId: ref('menu_items', true), targetType: { type: DataTypes.ENUM('url', 'product', 'category', 'collection', 'page'), allowNull: false }, targetId: DataTypes.CHAR(26), url: DataTypes.STRING(1000), labelEn: { type: DataTypes.STRING(180), allowNull: false }, labelBn: { type: DataTypes.STRING(180), allowNull: false }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, ...timestamps() }, tableOptions);
  await queryInterface.createTable('homepage_sections', { id: id(), type: { type: DataTypes.ENUM('hero', 'banner', 'product_carousel', 'category_grid', 'collection_grid', 'countdown', 'testimonials', 'editorial', 'newsletter', 'blog_feed'), allowNull: false }, enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, displayOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, startsAt: DataTypes.DATE(3), endsAt: DataTypes.DATE(3), config: { type: DataTypes.JSON, allowNull: false }, status: { type: DataTypes.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('theme_settings', { id: id(), status: { type: DataTypes.ENUM('draft', 'published'), allowNull: false }, settings: { type: DataTypes.JSON, allowNull: false }, version: version(), publishedAt: DataTypes.DATE(3), ...timestamps() }, tableOptions);
  await queryInterface.createTable('content_revisions', { id: id(), entityType: { type: DataTypes.STRING(80), allowNull: false }, entityId: { type: DataTypes.CHAR(26), allowNull: false }, version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, payload: { type: DataTypes.JSON, allowNull: false }, actorId: ref('users'), changeSummary: DataTypes.STRING(500), publishedAt: DataTypes.DATE(3), createdAt: { type: DataTypes.DATE(3), allowNull: false } }, { ...tableOptions, uniqueKeys: { content_revision_unique: { fields: ['entityType', 'entityId', 'version'] } } });

  await queryInterface.createTable('feature_flags', { id: id(), key: { type: DataTypes.STRING(100), allowNull: false, unique: true }, enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, config: DataTypes.JSON, version: version(), updatedBy: ref('users', true), ...timestamps() }, tableOptions);
  await queryInterface.createTable('notification_templates', { id: id(), event: { type: DataTypes.STRING(100), allowNull: false }, channel: { type: DataTypes.ENUM('email', 'sms', 'dashboard'), allowNull: false }, locale: locale(), subject: DataTypes.STRING(255), body: { type: DataTypes.TEXT('long'), allowNull: false }, variables: { type: DataTypes.JSON, allowNull: false }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }, version: version(), ...timestamps() }, { ...tableOptions, uniqueKeys: { notification_template_unique: { fields: ['event', 'channel', 'locale'] } } });
  await queryInterface.createTable('notification_outbox', { id: id(), event: { type: DataTypes.STRING(100), allowNull: false }, channel: { type: DataTypes.ENUM('email', 'sms', 'dashboard'), allowNull: false }, locale: locale(), recipient: { type: DataTypes.STRING(255), allowNull: false }, templateId: ref('notification_templates', true), payload: { type: DataTypes.JSON, allowNull: false }, renderedSubject: DataTypes.STRING(255), renderedBody: DataTypes.TEXT('long'), status: { type: DataTypes.ENUM('pending', 'processing', 'sent', 'retry', 'dead'), allowNull: false, defaultValue: 'pending' }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, scheduledAt: { type: DataTypes.DATE(3), allowNull: false }, sentAt: DataTypes.DATE(3), providerMessageId: DataTypes.STRING(190), errorCode: DataTypes.STRING(100), lastError: DataTypes.STRING(500), ...timestamps() }, tableOptions);
  await queryInterface.createTable('outbox_events', { id: id(), topic: { type: DataTypes.STRING(120), allowNull: false }, aggregateType: { type: DataTypes.STRING(100), allowNull: false }, aggregateId: { type: DataTypes.CHAR(26), allowNull: false }, payload: { type: DataTypes.JSON, allowNull: false }, status: { type: DataTypes.ENUM('pending', 'processing', 'published', 'failed'), allowNull: false, defaultValue: 'pending' }, attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, availableAt: { type: DataTypes.DATE(3), allowNull: false }, processedAt: DataTypes.DATE(3), ...timestamps() }, tableOptions);
  await queryInterface.createTable('integration_credentials', { id: id(), provider: { type: DataTypes.STRING(100), allowNull: false }, environment: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'default' }, encryptedPayload: { type: DataTypes.TEXT('long'), allowNull: false }, maskedLabel: { type: DataTypes.STRING(255), allowNull: false }, active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, testedAt: DataTypes.DATE(3), testStatus: DataTypes.STRING(40), version: version(), updatedBy: ref('users', true), ...timestamps() }, { ...tableOptions, uniqueKeys: { integration_provider_environment_unique: { fields: ['provider', 'environment'] } } });
  await queryInterface.createTable('webhooks', { id: id(), name: { type: DataTypes.STRING(160), allowNull: false }, topics: { type: DataTypes.JSON, allowNull: false }, url: { type: DataTypes.STRING(1000), allowNull: false }, encryptedSecret: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM('active', 'paused', 'disabled'), allowNull: false, defaultValue: 'active' }, failureCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, version: version(), ...timestamps(true) }, tableOptions);
  await queryInterface.createTable('webhook_deliveries', { id: id(), webhookId: ref('webhooks'), eventId: ref('outbox_events', true), attempt: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false }, signature: DataTypes.STRING(255), status: { type: DataTypes.ENUM('pending', 'success', 'retry', 'dead'), allowNull: false }, responseCode: DataTypes.INTEGER, durationMs: DataTypes.INTEGER.UNSIGNED, requestBody: DataTypes.JSON, responseExcerpt: DataTypes.STRING(1000), errorCode: DataTypes.STRING(100), nextAttemptAt: DataTypes.DATE(3), ...timestamps() }, tableOptions);
  await queryInterface.createTable('contact_messages', { id: id(), name: { type: DataTypes.STRING(120), allowNull: false }, phone: DataTypes.STRING(20), email: DataTypes.STRING(190), subject: { type: DataTypes.STRING(180), allowNull: false }, message: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM('new', 'in_progress', 'resolved', 'spam'), allowNull: false, defaultValue: 'new' }, ipHash: DataTypes.CHAR(64), ...timestamps() }, tableOptions);
  await queryInterface.createTable('export_jobs', { id: id(), requestedBy: ref('users'), report: { type: DataTypes.STRING(100), allowNull: false }, filters: DataTypes.JSON, status: { type: DataTypes.ENUM('queued', 'processing', 'ready', 'failed', 'expired'), allowNull: false }, mediaId: ref('media_assets', true), expiresAt: DataTypes.DATE(3), errorCode: DataTypes.STRING(100), ...timestamps() }, tableOptions);

  await queryInterface.addIndex('audit_logs', ['resourceType', 'resourceId', 'createdAt']);
  await queryInterface.addIndex('audit_logs', ['actorId', 'createdAt']);
  await queryInterface.addIndex('media_assets', ['status', 'privacy', 'createdAt']);
  await queryInterface.addIndex('verification_tokens', ['userId', 'channel', 'purpose', 'expiresAt']);
  await queryInterface.addIndex('inventory_reservations', ['status', 'expiresAt']);
  await queryInterface.addIndex('coupon_usages', ['couponId', 'status', 'createdAt']);
  await queryInterface.addIndex('payments', ['status', 'createdAt']);
  await queryInterface.addIndex('return_requests', ['status', 'createdAt']);
  await queryInterface.addIndex('notification_outbox', ['status', 'scheduledAt']);
  await queryInterface.addIndex('outbox_events', ['status', 'availableAt']);
  await queryInterface.addIndex('webhook_deliveries', ['status', 'nextAttemptAt']);
}

export async function down({ context: queryInterface }) {
  const tables = [
    'export_jobs', 'contact_messages', 'webhook_deliveries', 'webhooks', 'integration_credentials', 'outbox_events', 'notification_outbox', 'notification_templates', 'feature_flags', 'content_revisions', 'theme_settings', 'homepage_sections', 'menu_items', 'menus', 'post_translations', 'posts', 'post_categories', 'page_translations', 'pages', 'return_media', 'return_events', 'return_items', 'return_requests', 'review_media', 'reviews', 'wishlist_items', 'wishlists', 'shipment_events', 'shipments', 'shipping_methods', 'shipping_zones', 'refunds', 'payment_attempts', 'payments', 'order_notes', 'order_addresses', 'checkout_quotes', 'coupon_usages', 'cart_coupons', 'coupon_category_exclusions', 'coupon_categories', 'coupon_product_exclusions', 'coupon_products', 'coupons', 'inventory_reservations', 'stock_locations', 'redirects', 'related_products', 'product_size_charts', 'size_chart_rows', 'size_charts', 'product_media', 'variant_attribute_values', 'product_attribute_values', 'product_attributes', 'product_tags', 'product_collections', 'product_categories', 'attribute_value_translations', 'attribute_values', 'attribute_translations', 'attributes', 'brand_translations', 'brands', 'collection_translations', 'collections', 'user_addresses', 'mfa_recovery_codes', 'mfa_methods', 'auth_challenges', 'password_reset_tokens', 'verification_tokens', 'user_permission_overrides', 'audit_logs', 'media_assets',
  ];

  await queryInterface.removeIndex('inventory_levels', 'inventory_levels_variant_location_unique');
  await queryInterface.addIndex('inventory_levels', ['variantId'], { unique: true, name: 'inventory_levels_variant_unique' });

  const removeColumns = {
    inventory_movements: ['note', 'actorId', 'reservedAfter', 'onHandBefore', 'reservedDelta', 'locationId'],
    order_events: ['toStatus', 'fromStatus', 'actorId'],
    order_items: ['returnedQuantity', 'fulfilledQuantity', 'taxTotal', 'discountTotal', 'salePrice', 'regularPrice'],
    orders: ['metadata', 'completedAt', 'placedAt', 'currency'],
    reviews: ['respondedAt', 'staffResponse'],
    cart_items: ['metadata', 'unitPriceSnapshot'],
    inventory_levels: ['locationId'],
    product_variants: ['combinationSignature', 'dimensions', 'weightGrams', 'preorderMessage', 'preorderAvailableAt', 'saleEndsAt', 'saleStartsAt', 'status', 'barcode'],
    product_translations: ['seoDescription', 'seoTitle', 'materialText', 'careText'],
    products: ['reviewCount', 'reviewAverage', 'shippingProfile', 'taxClass', 'canonicalUrl', 'publishAt', 'visibility', 'brandId'],
    category_translations: ['seoDescription', 'seoTitle'],
    categories: ['version', 'imageId', 'parentId'],
    role_permissions: ['allow'],
    permissions: ['module'],
    roles: ['system', 'active'],
    users: ['version', 'riskLevel', 'mustChangePassword'],
  };
  for (const [table, columns] of Object.entries(removeColumns)) {
    for (const column of columns) await queryInterface.removeColumn(table, column);
  }
  for (const table of tables) await queryInterface.dropTable(table);
}
