import { DataTypes } from "sequelize";
import type { MigrationContext } from "./migration.types.js";

/** BE-RISK: the blocklist also accepts a client IP prefix (/24 or /64). */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.changeColumn("risk_blocklist", "type", {
    type: DataTypes.ENUM("phone", "email", "ip_prefix"),
    allowNull: false,
  });
}

export async function down({ context: queryInterface }: MigrationContext) {
  await queryInterface.sequelize.query(
    "DELETE FROM risk_blocklist WHERE type = 'ip_prefix'",
  );
  await queryInterface.changeColumn("risk_blocklist", "type", {
    type: DataTypes.ENUM("phone", "email"),
    allowNull: false,
  });
}
