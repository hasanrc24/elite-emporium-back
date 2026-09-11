import { Global, Module } from "@nestjs/common";
import { env } from "../config/env.js";
import { sequelize } from "../db/sequelize.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import * as mediaStorage from "../modules/media/media.storage.js";
import { InfrastructureService } from "./infrastructure.service.js";
import {
  APPLICATION_LOGGER,
  DATABASE,
  ENVIRONMENT,
  MEDIA_STORAGE,
  REDIS_CLIENT,
} from "./infrastructure.tokens.js";

@Global()
@Module({
  providers: [
    { provide: ENVIRONMENT, useValue: env },
    { provide: DATABASE, useValue: sequelize },
    { provide: REDIS_CLIENT, useValue: redis },
    { provide: APPLICATION_LOGGER, useValue: logger },
    { provide: MEDIA_STORAGE, useValue: mediaStorage },
    InfrastructureService,
  ],
  exports: [
    ENVIRONMENT,
    DATABASE,
    REDIS_CLIENT,
    APPLICATION_LOGGER,
    MEDIA_STORAGE,
    InfrastructureService,
  ],
})
export class InfrastructureModule {}
