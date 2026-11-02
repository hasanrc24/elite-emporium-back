import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

/**
 * The ProductVariant model, product schemas and admin UI accept the
 * `available` stock policy, but 001 created the column as
 * ENUM("deny", "allow_backorder", "preorder"), so saving such a variant
 * failed in MySQL strict mode. Widen the column to match the model.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.changeColumn("product_variants", "stockPolicy", {
    type: DataTypes.ENUM("deny", "allow_backorder", "preorder", "available"),
    allowNull: false,
    defaultValue: "deny",
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  // `available` variants are purchasable without stock, which is closest to
  // `allow_backorder` in the original enum.
  await queryInterface.sequelize.query(
    "UPDATE product_variants SET stockPolicy = 'allow_backorder' WHERE stockPolicy = 'available'",
  );
  await queryInterface.changeColumn("product_variants", "stockPolicy", {
    type: DataTypes.ENUM("deny", "allow_backorder", "preorder"),
    allowNull: false,
    defaultValue: "deny",
  });
}
