import { Module } from "@nestjs/common";
import { AdminInventoryController } from "./inventory.controller.js";

@Module({
  controllers: [AdminInventoryController],
})
export class InventoryModule {}
