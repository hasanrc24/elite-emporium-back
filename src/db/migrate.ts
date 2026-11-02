import path from "node:path";
import { fileURLToPath } from "node:url";
import { Umzug, SequelizeStorage } from "umzug";
import { sequelize } from "./sequelize.js";
import { logger } from "../lib/logger.js";

const migrationsDirectory = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);

const migrator = new Umzug({
  // Only numbered files are migrations; helper modules such as
  // migration.types.js compile into the same directory and have no `up`.
  migrations: { glob: path.join(migrationsDirectory, "[0-9]*.js") },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger,
});

const direction = process.argv[2] || "up";
try {
  if (direction === "down") await migrator.down();
  else await migrator.up();
  await sequelize.close();
} catch (error) {
  logger.error({ err: error }, "Migration failed");
  await sequelize.close();
  process.exitCode = 1;
}
