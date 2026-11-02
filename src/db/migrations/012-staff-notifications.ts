import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };

/**
 * BR-NOTIFY-001 dashboard alerts: each `dashboard` outbox row is fanned out by
 * the worker into one inbox row per eligible staff member so read state is
 * per person. `permission` is re-checked on read, so staff who lose access
 * stop seeing alerts that were delivered to them earlier.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.createTable(
    "staff_notifications",
    {
      id: { type: DataTypes.CHAR(26), allowNull: false, primaryKey: true },
      userId: {
        type: DataTypes.CHAR(26),
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      outboxId: {
        type: DataTypes.CHAR(26),
        allowNull: true,
        references: { model: "notification_outbox", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      event: { type: DataTypes.STRING(100), allowNull: false },
      category: { type: DataTypes.STRING(40), allowNull: false },
      severity: {
        type: DataTypes.ENUM("info", "success", "warning", "critical"),
        allowNull: false,
        defaultValue: "info",
      },
      permission: DataTypes.STRING(100),
      title: { type: DataTypes.STRING(255), allowNull: false },
      body: DataTypes.TEXT,
      link: DataTypes.STRING(500),
      dedupeKey: DataTypes.STRING(190),
      occurrences: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      occurredAt: { type: DataTypes.DATE(3), allowNull: false },
      readAt: DataTypes.DATE(3),
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    {
      ...tableOptions,
      uniqueKeys: {
        // A retried outbox row must not create a second inbox entry.
        staff_notification_delivery_unique: { fields: ["outboxId", "userId"] },
      },
    },
  );
  await queryInterface.addIndex("staff_notifications", {
    name: "staff_notification_inbox",
    fields: ["userId", "readAt", "occurredAt"],
  });
  await queryInterface.addIndex("staff_notifications", {
    name: "staff_notification_feed",
    fields: ["userId", "occurredAt"],
  });
  await queryInterface.addIndex("staff_notifications", {
    name: "staff_notification_dedupe",
    fields: ["userId", "dedupeKey"],
  });
  // An alert switched off by deactivating its template is recorded as skipped
  // rather than pretending it was sent.
  await queryInterface.changeColumn("notification_outbox", "status", {
    type: DataTypes.ENUM(
      "pending",
      "processing",
      "sent",
      "retry",
      "dead",
      "skipped",
    ),
    allowNull: false,
    defaultValue: "pending",
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.bulkUpdate(
    "notification_outbox",
    { status: "sent" },
    { status: "skipped" },
  );
  await queryInterface.changeColumn("notification_outbox", "status", {
    type: DataTypes.ENUM("pending", "processing", "sent", "retry", "dead"),
    allowNull: false,
    defaultValue: "pending",
  });
  await queryInterface.dropTable("staff_notifications");
}
