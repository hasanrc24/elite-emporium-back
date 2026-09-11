import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module.js";
import { sequelize } from "./db/sequelize.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { closeRedis, pingRedis } from "./lib/redis.js";
import { ensureMediaDirectories } from "./modules/media/media.storage.js";
import { recoverStaleJobs } from "./jobs/job-runner.js";

try {
  await sequelize.authenticate();
  await ensureMediaDirectories();
  if (!env.REDIS_OPTIONAL) await pingRedis();
  const recovered = await recoverStaleJobs();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  app.enableShutdownHooks();
  logger.info({ recovered }, "Elite Emporium NestJS worker ready");
} catch (error) {
  logger.fatal({ err: error }, "Worker startup failed");
  await closeRedis().catch(() => undefined);
  await sequelize.close().catch(() => undefined);
  process.exitCode = 1;
}
