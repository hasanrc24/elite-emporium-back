import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };

/**
 * Meta Conversions API queue. Rows carry already-hashed user data, so no raw
 * email or phone is kept. `held` rows wait for a prepaid order's payment.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.createTable(
    "meta_capi_events",
    {
      id: { type: DataTypes.CHAR(26), allowNull: false, primaryKey: true },
      eventId: { type: DataTypes.STRING(120), allowNull: false },
      eventName: { type: DataTypes.STRING(40), allowNull: false },
      eventTime: { type: DataTypes.DATE(3), allowNull: false },
      payload: { type: DataTypes.JSON, allowNull: false },
      status: {
        type: DataTypes.ENUM("held", "pending", "processing", "sent", "failed"),
        allowNull: false,
        defaultValue: "pending",
      },
      attempts: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      nextAttemptAt: { type: DataTypes.DATE(3), allowNull: false },
      leaseUntil: DataTypes.DATE(3),
      lastError: DataTypes.STRING(500),
      sentAt: DataTypes.DATE(3),
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    {
      ...tableOptions,
      uniqueKeys: { meta_capi_event_id_unique: { fields: ["eventId"] } },
    },
  );
  await queryInterface.addIndex("meta_capi_events", {
    name: "meta_capi_queue",
    fields: ["status", "nextAttemptAt"],
  });
  await queryInterface.addIndex("meta_capi_events", {
    name: "meta_capi_created",
    fields: ["createdAt"],
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.dropTable("meta_capi_events");
}
