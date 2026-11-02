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

/**
 * MariaDB stores JSON as LONGTEXT, so mysql2 hands back the serialized text
 * instead of a value. Only objects/arrays are decoded: a JSON string scalar
 * already arrives decoded on MySQL and must not be parsed a second time.
 */
export function decodeJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!/^[[{]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

const isJsonType = (type: RuntimeValue) =>
  type === DataTypes.JSON || type instanceof DataTypes.JSON;

function withJsonDecoding(attributes: ModelAttributes<DynamicModel>) {
  const decoded: RuntimeValue = {};
  for (const [name, definition] of Object.entries(attributes) as [
    string,
    RuntimeValue,
  ][]) {
    const column = isJsonType(definition) ? { type: definition } : definition;
    decoded[name] =
      isJsonType(column?.type) && !column.get
        ? {
            ...column,
            get(this: DynamicModel) {
              return decodeJsonValue(this.getDataValue(name));
            },
          }
        : definition;
  }
  return decoded as ModelAttributes<DynamicModel>;
}

export function initializeModel(
  ModelClass: ModelStatic<DynamicModel>,
  attributes: ModelAttributes<DynamicModel>,
  options: Omit<InitOptions<DynamicModel>, "sequelize">,
) {
  ModelClass.init(withJsonDecoding(attributes), {
    sequelize,
    freezeTableName: true,
    ...options,
  });
  return ModelClass;
}

export { DataTypes };
