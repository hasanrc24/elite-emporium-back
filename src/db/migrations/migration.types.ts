import type { QueryInterface } from "sequelize";

export interface MigrationContext {
  context: QueryInterface;
}
