import { Module } from "@nestjs/common";
import { AdminMediaController, MediaController } from "./media.controller.js";

@Module({
  controllers: [MediaController, AdminMediaController],
})
export class MediaModule {}
