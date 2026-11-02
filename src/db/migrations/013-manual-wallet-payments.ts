import { DataTypes, QueryTypes } from "sequelize";
import { newId } from "../../lib/ids.js";
import type { MigrationContext } from "./migration.types.js";

const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };

const permissionKey = "payments.verify_manual";
const permissionDescription = "Verify manual mobile-wallet payments";
// Roles that receive the permission on databases that already exist. Custom
// roles and the permissions staff already hold are left untouched.
const grantedRoleKeys = ["owner", "administrator", "order_manager"];

/**
 * BR-PAY-006: customers report a bKash/Nagad/Rocket/Upay TrxID against an
 * order and staff verify it. A TrxID can be used once per provider.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.createTable(
    "manual_payment_claims",
    {
      id: { type: DataTypes.CHAR(26), allowNull: false, primaryKey: true },
      orderId: {
        type: DataTypes.CHAR(26),
        allowNull: false,
        references: { model: "orders", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      paymentId: {
        type: DataTypes.CHAR(26),
        allowNull: false,
        references: { model: "payments", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      provider: {
        type: DataTypes.ENUM("bkash", "nagad", "rocket", "upay"),
        allowNull: false,
      },
      senderPhone: { type: DataTypes.STRING(20), allowNull: false },
      trxId: { type: DataTypes.STRING(40), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      status: {
        type: DataTypes.ENUM("submitted", "verified", "rejected", "expired"),
        allowNull: false,
        defaultValue: "submitted",
      },
      reviewedBy: {
        type: DataTypes.CHAR(26),
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      reviewedAt: DataTypes.DATE(3),
      rejectionReason: DataTypes.STRING(500),
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    {
      ...tableOptions,
      uniqueKeys: {
        // A TrxID proves one payment, so it can back only one claim.
        manual_payment_trx_unique: { fields: ["provider", "trxId"] },
      },
    },
  );
  await queryInterface.addIndex("manual_payment_claims", {
    name: "manual_payment_queue",
    fields: ["status", "createdAt"],
  });
  await queryInterface.addIndex("manual_payment_claims", {
    name: "manual_payment_order",
    fields: ["orderId", "status"],
  });

  const sequelize = queryInterface.sequelize;
  const now = new Date();
  const existing = await sequelize.query<{ id: string }>(
    "SELECT id FROM permissions WHERE `key` = :key LIMIT 1",
    { replacements: { key: permissionKey }, type: QueryTypes.SELECT },
  );
  let permissionId = existing[0]?.id;
  if (!permissionId) {
    permissionId = newId();
    await queryInterface.bulkInsert("permissions", [
      {
        id: permissionId,
        key: permissionKey,
        module: "payments",
        description: permissionDescription,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  }
  const roles = await sequelize.query<{ id: string }>(
    "SELECT id FROM roles WHERE `key` IN (:keys)",
    { replacements: { keys: grantedRoleKeys }, type: QueryTypes.SELECT },
  );
  for (const role of roles)
    // INSERT IGNORE relies on the (roleId, permissionId) unique key.
    await sequelize.query(
      "INSERT IGNORE INTO role_permissions (roleId, permissionId, allow, createdAt, updatedAt) VALUES (:roleId, :permissionId, 1, :now, :now)",
      { replacements: { roleId: role.id, permissionId, now } },
    );
}

export async function down({ context: queryInterface }: MigrationContext) {
  const sequelize = queryInterface.sequelize;
  const rows = await sequelize.query<{ id: string }>(
    "SELECT id FROM permissions WHERE `key` = :key LIMIT 1",
    { replacements: { key: permissionKey }, type: QueryTypes.SELECT },
  );
  if (rows[0]) {
    await sequelize.query(
      "DELETE FROM user_permission_overrides WHERE permissionId = :id",
      { replacements: { id: rows[0].id } },
    );
    await sequelize.query(
      "DELETE FROM role_permissions WHERE permissionId = :id",
      { replacements: { id: rows[0].id } },
    );
    await sequelize.query("DELETE FROM permissions WHERE id = :id", {
      replacements: { id: rows[0].id },
    });
  }
  await queryInterface.dropTable("manual_payment_claims");
}
