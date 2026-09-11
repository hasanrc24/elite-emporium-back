import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

const tableOptions = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };
const id = () => ({
  type: DataTypes.CHAR(26),
  allowNull: false,
  primaryKey: true,
});
const ref = (table: string) => ({
  type: DataTypes.CHAR(26),
  allowNull: false,
  references: { model: table, key: "id" },
  onUpdate: "CASCADE",
  onDelete: "CASCADE",
});
const timestamps = () => ({
  createdAt: { type: DataTypes.DATE(3), allowNull: false },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false },
});

export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.createTable(
    "coupon_users",
    {
      couponId: ref("coupons"),
      userId: ref("users"),
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: { coupon_user_unique: { fields: ["couponId", "userId"] } },
    },
  );
  await queryInterface.createTable(
    "coupon_phones",
    {
      id: id(),
      couponId: ref("coupons"),
      phone: { type: DataTypes.STRING(20), allowNull: false },
      ...timestamps(),
    },
    {
      ...tableOptions,
      uniqueKeys: { coupon_phone_unique: { fields: ["couponId", "phone"] } },
    },
  );
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.dropTable("coupon_phones");
  await queryInterface.dropTable("coupon_users");
}
