import { Module } from "@nestjs/common";
import {
  AdminContentController,
  ContentController,
} from "./content.controller.js";

@Module({
  controllers: [ContentController, AdminContentController],
})
export class ContentModule {}
