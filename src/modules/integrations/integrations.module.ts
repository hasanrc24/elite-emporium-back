import { Module } from "@nestjs/common";
import { AdminIntegrationController } from "./integration.controller.js";

@Module({
  controllers: [AdminIntegrationController],
})
export class IntegrationsModule {}
