import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };
const id = () => ({
  type: DataTypes.CHAR(26),
  allowNull: false,
  primaryKey: true,
});
const ref = (table: string, allowNull = false) => ({
  type: DataTypes.CHAR(26),
  allowNull,
  references: { model: table, key: "id" },
  onUpdate: "CASCADE",
  onDelete: allowNull ? "SET NULL" : "RESTRICT",
});
const timestamps = () => ({
  createdAt: { type: DataTypes.DATE(3), allowNull: false },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false },
});

const fulfillmentWithRto = [
  "unfulfilled",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "returned_to_origin",
  "partially_returned",
  "returned",
];
const fulfillmentWithoutRto = fulfillmentWithRto.filter(
  (value) => value !== "returned_to_origin",
);

export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.addColumn("orders", "channel", {
    type: DataTypes.ENUM(
      "web",
      "facebook",
      "instagram",
      "whatsapp",
      "phone",
      "walk_in",
      "other",
    ),
    allowNull: false,
    defaultValue: "web",
  });
  await queryInterface.addColumn("orders", "confirmationStatus", {
    type: DataTypes.ENUM(
      "not_required",
      "pending",
      "confirmed",
      "no_answer",
      "wrong_number",
      "customer_cancelled",
      "call_back",
    ),
    allowNull: false,
    defaultValue: "not_required",
  });
  await queryInterface.addColumn("orders", "confirmationAttempts", {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  });
  await queryInterface.addColumn("orders", "nextConfirmationAt", {
    type: DataTypes.DATE(3),
  });
  await queryInterface.addColumn("orders", "confirmedAt", {
    type: DataTypes.DATE(3),
  });
  await queryInterface.addColumn("orders", "riskLevel", {
    type: DataTypes.ENUM("low", "medium", "high", "blocked"),
    allowNull: false,
    defaultValue: "low",
  });
  await queryInterface.addColumn("orders", "riskScore", {
    type: DataTypes.SMALLINT.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  });
  await queryInterface.addColumn("orders", "riskSignals", {
    type: DataTypes.JSON,
  });
  // A soft pointer (no FK) so the column can be dropped cleanly on rollback.
  await queryInterface.addColumn("orders", "duplicateOfOrderId", {
    type: DataTypes.CHAR(26),
  });
  await queryInterface.addColumn("orders", "tags", { type: DataTypes.JSON });
  await queryInterface.addColumn("orders", "attribution", {
    type: DataTypes.JSON,
  });
  await queryInterface.changeColumn("orders", "fulfillmentStatus", {
    type: DataTypes.ENUM(...fulfillmentWithRto),
    allowNull: false,
  });
  // (customerPhone, createdAt) already exists from migration 001 and serves risk lookups.
  await queryInterface.addIndex("orders", ["confirmationStatus", "createdAt"]);
  await queryInterface.addIndex("orders", ["riskLevel", "createdAt"]);

  await queryInterface.addColumn("order_addresses", "thana", {
    type: DataTypes.STRING(120),
  });
  await queryInterface.addColumn("order_addresses", "locationCode", {
    type: DataTypes.STRING(60),
  });

  await queryInterface.addColumn("products", "fashion", {
    type: DataTypes.JSON,
  });
  await queryInterface.addColumn("reviews", "fit", {
    type: DataTypes.ENUM("small", "true_to_size", "large"),
  });

  await queryInterface.createTable(
    "order_confirmations",
    {
      id: id(),
      orderId: ref("orders"),
      actorId: ref("users", true),
      method: {
        type: DataTypes.ENUM("call", "sms_link", "manual", "auto"),
        allowNull: false,
      },
      outcome: {
        type: DataTypes.ENUM(
          "confirmed",
          "no_answer",
          "wrong_number",
          "customer_cancelled",
          "call_back",
          "auto_cancelled",
        ),
        allowNull: false,
      },
      note: DataTypes.STRING(500),
      callbackAt: DataTypes.DATE(3),
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    tableOptions,
  );
  await queryInterface.addIndex("order_confirmations", [
    "orderId",
    "createdAt",
  ]);

  await queryInterface.createTable(
    "risk_blocklist",
    {
      id: id(),
      type: { type: DataTypes.ENUM("phone", "email"), allowNull: false },
      value: { type: DataTypes.STRING(190), allowNull: false },
      reason: { type: DataTypes.STRING(255), allowNull: false },
      actorId: ref("users", true),
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      expiresAt: DataTypes.DATE(3),
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: {
        risk_blocklist_value_unique: { fields: ["type", "value"] },
      },
    },
  );

  await queryInterface.createTable(
    "bd_locations",
    {
      id: id(),
      code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      level: {
        type: DataTypes.ENUM("division", "district", "thana"),
        allowNull: false,
      },
      parentCode: DataTypes.STRING(60),
      nameEn: { type: DataTypes.STRING(120), allowNull: false },
      nameBn: { type: DataTypes.STRING(120), allowNull: false },
      zoneCode: DataTypes.STRING(60),
      displayOrder: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.addIndex("bd_locations", ["level", "parentCode"]);

  await queryInterface.createTable(
    "search_synonyms",
    {
      id: id(),
      term: { type: DataTypes.STRING(80), allowNull: false, unique: true },
      synonyms: { type: DataTypes.JSON, allowNull: false },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      ...timestamps(),
    },
    tableOptions,
  );
  await queryInterface.createTable(
    "search_misses",
    {
      id: id(),
      query: { type: DataTypes.STRING(80), allowNull: false },
      locale: { type: DataTypes.ENUM("en", "bn"), allowNull: false },
      count: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      firstSeenAt: { type: DataTypes.DATE(3), allowNull: false },
      lastSeenAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    {
      ...tableOptions,
      uniqueKeys: { search_miss_unique: { fields: ["query", "locale"] } },
    },
  );
  await queryInterface.addIndex("search_misses", ["count"]);
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.dropTable("search_misses");
  await queryInterface.dropTable("search_synonyms");
  await queryInterface.dropTable("bd_locations");
  await queryInterface.dropTable("risk_blocklist");
  await queryInterface.dropTable("order_confirmations");
  await queryInterface.removeColumn("reviews", "fit");
  await queryInterface.removeColumn("products", "fashion");
  await queryInterface.removeColumn("order_addresses", "locationCode");
  await queryInterface.removeColumn("order_addresses", "thana");
  await queryInterface.removeIndex("orders", ["riskLevel", "createdAt"]);
  await queryInterface.removeIndex("orders", [
    "confirmationStatus",
    "createdAt",
  ]);
  // Rows parked in returned_to_origin must leave the enum value first.
  await queryInterface.sequelize.query(
    "UPDATE orders SET fulfillmentStatus = 'returned' WHERE fulfillmentStatus = 'returned_to_origin'",
  );
  await queryInterface.changeColumn("orders", "fulfillmentStatus", {
    type: DataTypes.ENUM(...fulfillmentWithoutRto),
    allowNull: false,
  });
  for (const column of [
    "attribution",
    "tags",
    "duplicateOfOrderId",
    "riskSignals",
    "riskScore",
    "riskLevel",
    "confirmedAt",
    "nextConfirmationAt",
    "confirmationAttempts",
    "confirmationStatus",
    "channel",
  ])
    await queryInterface.removeColumn("orders", column);
}
