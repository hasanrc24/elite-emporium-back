import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

const id = () => ({
  type: DataTypes.CHAR(26),
  allowNull: false,
  primaryKey: true,
});
const timestamps = () => ({
  createdAt: { type: DataTypes.DATE(3), allowNull: false },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false },
});
const ref = (table: string, allowNull = false) => ({
  type: DataTypes.CHAR(26),
  allowNull,
  references: { model: table, key: "id" },
  onUpdate: "CASCADE",
  onDelete: allowNull ? "SET NULL" : "RESTRICT",
});
// Use a deterministic Unicode collation supported by both the production
// MySQL 8.4 target and MariaDB-based local development installations.
const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };

export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.createTable(
    "users",
    {
      id: id(),
      name: { type: DataTypes.STRING(120), allowNull: false },
      phone: { type: DataTypes.STRING(20), unique: true },
      email: { type: DataTypes.STRING(190), unique: true },
      passwordHash: { type: DataTypes.STRING(255), allowNull: false },
      status: {
        type: DataTypes.ENUM("active", "disabled"),
        allowNull: false,
        defaultValue: "active",
      },
      locale: {
        type: DataTypes.ENUM("en", "bn"),
        allowNull: false,
        defaultValue: "en",
      },
      phoneVerifiedAt: DataTypes.DATE(3),
      emailVerifiedAt: DataTypes.DATE(3),
      lastLoginAt: DataTypes.DATE(3),
      roleVersion: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      deletedAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "roles",
    {
      id: id(),
      key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      protected: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "permissions",
    {
      id: id(),
      key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      description: DataTypes.STRING(255),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "user_roles",
    { userId: ref("users"), roleId: ref("roles"), ...timestamps() },
    {
      ...tableOptions,
      uniqueKeys: { user_role_unique: { fields: ["userId", "roleId"] } },
    },
  );
  await queryInterface.createTable(
    "role_permissions",
    { roleId: ref("roles"), permissionId: ref("permissions"), ...timestamps() },
    {
      ...tableOptions,
      uniqueKeys: {
        role_permission_unique: { fields: ["roleId", "permissionId"] },
      },
    },
  );
  await queryInterface.createTable(
    "auth_sessions",
    {
      id: id(),
      userId: ref("users"),
      familyId: { type: DataTypes.CHAR(26), allowNull: false, unique: true },
      currentJtiHash: { type: DataTypes.CHAR(64), allowNull: false },
      expiresAt: { type: DataTypes.DATE(3), allowNull: false },
      lastUsedAt: { type: DataTypes.DATE(3), allowNull: false },
      userAgent: DataTypes.STRING(255),
      ipAddress: DataTypes.STRING(64),
      revokedAt: DataTypes.DATE(3),
      revokeReason: DataTypes.STRING(120),
      ...timestamps(),
    },
    tableOptions,
  );

  await queryInterface.createTable(
    "categories",
    {
      id: id(),
      slug: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      displayOrder: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      deletedAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "category_translations",
    {
      id: id(),
      categoryId: ref("categories"),
      locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
      name: { type: DataTypes.STRING(180), allowNull: false },
      description: DataTypes.TEXT,
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: {
        category_locale_unique: { fields: ["categoryId", "locale"] },
      },
    },
  );
  await queryInterface.createTable(
    "products",
    {
      id: id(),
      categoryId: ref("categories", true),
      slug: { type: DataTypes.STRING(180), allowNull: false, unique: true },
      type: {
        type: DataTypes.ENUM("simple", "variable"),
        allowNull: false,
        defaultValue: "simple",
      },
      status: {
        type: DataTypes.ENUM("draft", "scheduled", "published", "archived"),
        allowNull: false,
        defaultValue: "draft",
      },
      featured: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      publishedAt: DataTypes.DATE(3),
      deletedAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "product_translations",
    {
      id: id(),
      productId: ref("products"),
      locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
      name: { type: DataTypes.STRING(220), allowNull: false },
      shortDescription: DataTypes.TEXT,
      description: DataTypes.TEXT("long"),
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: {
        product_locale_unique: { fields: ["productId", "locale"] },
      },
    },
  );
  await queryInterface.createTable(
    "product_variants",
    {
      id: id(),
      productId: ref("products"),
      sku: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      title: { type: DataTypes.STRING(180), allowNull: false },
      attributes: { type: DataTypes.JSON, allowNull: false },
      regularPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      salePrice: DataTypes.DECIMAL(12, 2),
      costPrice: DataTypes.DECIMAL(12, 2),
      stockPolicy: {
        type: DataTypes.ENUM("deny", "allow_backorder", "preorder"),
        allowNull: false,
        defaultValue: "deny",
      },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      isDefault: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      deletedAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "inventory_levels",
    {
      id: id(),
      variantId: { ...ref("product_variants"), unique: true },
      onHand: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      reserved: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      lowStockThreshold: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 3,
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "store_settings",
    {
      id: id(),
      key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      value: { type: DataTypes.JSON, allowNull: false },
      isPublic: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      ...timestamps(),
    },
    tableOptions,
  );

  await queryInterface.createTable(
    "carts",
    {
      id: id(),
      userId: ref("users", true),
      tokenHash: { type: DataTypes.CHAR(64), unique: true },
      status: {
        type: DataTypes.ENUM("active", "converted", "expired"),
        allowNull: false,
        defaultValue: "active",
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      expiresAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "cart_items",
    {
      id: id(),
      cartId: ref("carts"),
      variantId: ref("product_variants"),
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: { cart_variant_unique: { fields: ["cartId", "variantId"] } },
    },
  );
  await queryInterface.createTable(
    "orders",
    {
      id: id(),
      userId: ref("users", true),
      reference: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      source: {
        type: DataTypes.ENUM("storefront", "admin"),
        allowNull: false,
        defaultValue: "storefront",
      },
      orderStatus: {
        type: DataTypes.ENUM(
          "draft",
          "pending_payment",
          "placed",
          "confirmed",
          "processing",
          "completed",
          "cancelled",
          "failed",
        ),
        allowNull: false,
      },
      paymentStatus: {
        type: DataTypes.ENUM(
          "unpaid",
          "pending",
          "paid",
          "failed",
          "cancelled",
          "partially_refunded",
          "refunded",
        ),
        allowNull: false,
      },
      fulfillmentStatus: {
        type: DataTypes.ENUM(
          "unfulfilled",
          "processing",
          "packed",
          "shipped",
          "out_for_delivery",
          "delivered",
          "partially_returned",
          "returned",
        ),
        allowNull: false,
      },
      paymentMethod: { type: DataTypes.ENUM("cod", "bkash"), allowNull: false },
      customerName: { type: DataTypes.STRING(120), allowNull: false },
      customerPhone: { type: DataTypes.STRING(20), allowNull: false },
      customerEmail: DataTypes.STRING(190),
      address: { type: DataTypes.TEXT, allowNull: false },
      deliveryCode: { type: DataTypes.STRING(60), allowNull: false },
      deliveryLabel: { type: DataTypes.STRING(120), allowNull: false },
      subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      discountTotal: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      deliveryTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      taxTotal: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      grandTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      locale: {
        type: DataTypes.ENUM("en", "bn"),
        allowNull: false,
        defaultValue: "en",
      },
      note: DataTypes.TEXT,
      cancellationReason: DataTypes.STRING(255),
      cancelledAt: DataTypes.DATE(3),
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "order_items",
    {
      id: id(),
      orderId: ref("orders"),
      variantId: ref("product_variants", true),
      productName: { type: DataTypes.STRING(220), allowNull: false },
      variantTitle: DataTypes.STRING(180),
      sku: { type: DataTypes.STRING(100), allowNull: false },
      attributes: DataTypes.JSON,
      unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      unitCost: DataTypes.DECIMAL(12, 2),
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      lineTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "order_events",
    {
      id: id(),
      orderId: ref("orders"),
      type: { type: DataTypes.STRING(80), allowNull: false },
      message: { type: DataTypes.STRING(255), allowNull: false },
      public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      metadata: DataTypes.JSON,
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "inventory_movements",
    {
      id: id(),
      variantId: ref("product_variants"),
      orderId: ref("orders", true),
      quantityDelta: { type: DataTypes.INTEGER, allowNull: false },
      reason: { type: DataTypes.STRING(80), allowNull: false },
      balanceAfter: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      correlationId: DataTypes.STRING(100),
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "idempotency_records",
    {
      id: id(),
      scope: { type: DataTypes.STRING(100), allowNull: false },
      key: { type: DataTypes.STRING(150), allowNull: false },
      actorKey: { type: DataTypes.STRING(150), allowNull: false },
      requestHash: { type: DataTypes.CHAR(64), allowNull: false },
      responseStatus: DataTypes.INTEGER,
      responseBody: DataTypes.JSON,
      expiresAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: {
        idempotency_unique: { fields: ["scope", "key", "actorKey"] },
      },
    },
  );

  await queryInterface.addIndex("products", ["status", "featured"]);
  await queryInterface.addIndex("orders", ["orderStatus", "createdAt"]);
  await queryInterface.addIndex("orders", ["customerPhone", "createdAt"]);
  await queryInterface.addIndex("inventory_movements", [
    "variantId",
    "createdAt",
  ]);
}

export async function down({ context: queryInterface }: MigrationContext) {
  const tables = [
    "idempotency_records",
    "inventory_movements",
    "order_events",
    "order_items",
    "orders",
    "cart_items",
    "carts",
    "store_settings",
    "inventory_levels",
    "product_variants",
    "product_translations",
    "products",
    "category_translations",
    "categories",
    "auth_sessions",
    "role_permissions",
    "user_roles",
    "permissions",
    "roles",
    "users",
  ];
  for (const table of tables) await queryInterface.dropTable(table);
}
