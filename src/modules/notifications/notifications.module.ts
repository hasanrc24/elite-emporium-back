import { Module } from "@nestjs/common";
import { StaffNotificationController } from "./staff-notification.controller.js";

@Module({ controllers: [StaffNotificationController] })
export class NotificationsModule {}
