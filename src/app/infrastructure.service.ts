import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { Sequelize } from "sequelize";
import type { Redis } from "ioredis";
import { DATABASE, REDIS_CLIENT } from "./infrastructure.tokens.js";

@Injectable()
export class InfrastructureService implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Sequelize,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.closeRedis(), this.database.close()]);
  }

  private async closeRedis(): Promise<void> {
    if (!["ready", "connect", "connecting"].includes(this.redis.status)) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
