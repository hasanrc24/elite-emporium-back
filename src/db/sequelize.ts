import { Sequelize } from "sequelize";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const sequelize = new Sequelize(
  env.DB_NAME,
  env.DB_USER,
  env.DB_PASSWORD,
  {
    host: env.DB_HOST,
    port: env.DB_PORT,
    dialect: "mysql",
    logging:
      env.NODE_ENV === "development"
        ? (message) => logger.debug({ sql: message })
        : false,
    pool: {
      max: env.DB_POOL_MAX,
      min: env.DB_POOL_MIN,
      acquire: env.DB_POOL_ACQUIRE_MS,
      idle: env.DB_POOL_IDLE_MS,
    },
    dialectOptions: env.DB_SSL ? { ssl: { rejectUnauthorized: true } } : {},
    define: { freezeTableName: true, timestamps: true },
  },
);
