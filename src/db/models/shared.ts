import {
  DataTypes,
  Model,
  type InitOptions,
  type ModelAttributes,
  type ModelStatic,
} from "sequelize";
import { sequelize } from "../sequelize.js";

export const primaryId = () => ({
  type: DataTypes.CHAR(26),
  primaryKey: true,
  allowNull: false,
});
export const optimisticVersion = () => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull: false,
  defaultValue: 1,
});

export class DynamicModel extends Model {
  [key: string]: ReturnType<typeof JSON.parse>;
  // Type-only declarations preserve Sequelize's runtime attribute accessors.
  declare id: string;
  declare roleVersion: number;
  declare roles: ReturnType<typeof JSON.parse>;
  declare permissionOverrides: ReturnType<typeof JSON.parse>;
}

export function initializeModel(
  ModelClass: ModelStatic<DynamicModel>,
  attributes: ModelAttributes<DynamicModel>,
  options: Omit<InitOptions<DynamicModel>, "sequelize">,
) {
  ModelClass.init(attributes, {
    sequelize,
    freezeTableName: true,
    ...options,
  });
  return ModelClass;
}

export { DataTypes };
