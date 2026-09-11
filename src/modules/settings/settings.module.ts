import { Module } from "@nestjs/common";
import {
  AdminSettingsController,
  StorefrontController,
} from "./settings.controller.js";

@Module({
  controllers: [AdminSettingsController, StorefrontController],
})
export class SettingsModule {}
