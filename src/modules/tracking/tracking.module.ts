import { Module } from "@nestjs/common";
import {
  AdminTrackingController,
  TrackingController,
} from "./tracking.controller.js";

@Module({ controllers: [TrackingController, AdminTrackingController] })
export class TrackingModule {}
