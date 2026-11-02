import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

/**
 * Size exchange fast path (BR-RET-001): the customer picks the replacement
 * variant when requesting an exchange, so staff can prepare the replacement
 * order without a follow-up call.
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.addColumn("return_items", "requestedVariantId", {
    type: DataTypes.CHAR(26),
    allowNull: true,
    references: { model: "product_variants", key: "id" },
    onUpdate: "CASCADE",
    onDelete: "SET NULL",
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.removeColumn("return_items", "requestedVariantId");
}
