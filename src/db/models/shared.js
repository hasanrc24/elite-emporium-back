import { DataTypes } from 'sequelize';
import { sequelize } from '../sequelize.js';

export const primaryId = () => ({ type: DataTypes.CHAR(26), primaryKey: true, allowNull: false });
export const optimisticVersion = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 });

export function initializeModel(ModelClass, attributes, options) {
  ModelClass.init(attributes, {
    sequelize,
    freezeTableName: true,
    ...options,
  });
  return ModelClass;
}

export { DataTypes };
