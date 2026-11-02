import {
  type BeforeApplicationShutdown,
  Injectable,
  type OnModuleInit,
} from "@nestjs/common";
import { runJobsOnce } from "../jobs/job-runner.js";
import { logger } from "../lib/logger.js";

@Injectable()
export class WorkerService implements OnModuleInit, BeforeApplicationShutdown {
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;

  onModuleInit(): void {
    this.schedule(0);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      if (this.stopping || this.active) return;
      this.active = this.tick().finally(() => {
        this.active = undefined;
        if (!this.stopping) this.schedule(2_000);
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      const completed: RuntimeValue = await runJobsOnce();
      if (completed && Object.values(completed).some(Boolean))
        logger.info({ completed }, "Background jobs processed");
    } catch (error: RuntimeValue) {
      logger.error({ err: error }, "Background job batch failed");
    }
  }

  // Runs before every onApplicationShutdown hook, so the in-flight batch
  // finishes before InfrastructureService closes MySQL and Redis.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
}
