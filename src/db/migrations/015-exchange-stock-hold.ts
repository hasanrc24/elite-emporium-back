import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

/** BE-RETURN-001: reservations may belong to a return item (exchange hold). */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.addColumn("inventory_reservations", "returnItemId", {
    type: DataTypes.CHAR(26),
    allowNull: true,
    references: { model: "return_items", key: "id" },
    onUpdate: "CASCADE",
    onDelete: "SET NULL",
  });
  await queryInterface.addIndex("inventory_reservations", ["returnItemId"], {
    name: "inventory_reservations_return_item",
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.removeIndex(
    "inventory_reservations",
    "inventory_reservations_return_item",
  );
  await queryInterface.removeColumn("inventory_reservations", "returnItemId");
}
