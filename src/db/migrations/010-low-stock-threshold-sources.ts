import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

/**
 * BE-INV-001: low-stock thresholds may be global, product or variant specific
 * and the most specific one wins. A NULL column means "inherit". The
 * inventory_levels.lowStockThreshold column keeps the resolved value so
 * existing dashboards and filters continue to work.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.addColumn("products", "lowStockThreshold", {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  });
  await queryInterface.addColumn("product_variants", "lowStockThreshold", {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.removeColumn("product_variants", "lowStockThreshold");
  await queryInterface.removeColumn("products", "lowStockThreshold");
}
