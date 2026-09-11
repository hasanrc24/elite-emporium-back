import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller.js";
import { AdminCustomerController } from "./customer.controller.js";
import { AdminOperationsController } from "./operations.controller.js";
import { AdminStaffController } from "./staff.controller.js";

@Module({
  controllers: [
    AdminController,
    AdminCustomerController,
    AdminOperationsController,
    AdminStaffController,
  ],
})
export class AdminModule {}
