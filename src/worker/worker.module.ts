import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../app/infrastructure.module.js";
import { WorkerService } from "./worker.service.js";

@Module({ imports: [InfrastructureModule], providers: [WorkerService] })
export class WorkerModule {}
