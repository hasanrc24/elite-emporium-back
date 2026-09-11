import { Module } from "@nestjs/common";
import { AdminReturnController } from "./admin-return.controller.js";
import { ReturnController } from "./return.controller.js";

@Module({
  controllers: [ReturnController, AdminReturnController],
})
export class ReturnsModule {}
