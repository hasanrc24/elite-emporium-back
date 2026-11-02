import { Module } from "@nestjs/common";
import { CheckoutController, OrderController } from "./order.controller.js";
import { AdminOrderController } from "./admin-order.controller.js";
import {
  AdminOrderOperationsController,
  LocationController,
  OrderConfirmationController,
} from "./order-operations.controller.js";

@Module({
  controllers: [
    CheckoutController,
    OrderConfirmationController,
    OrderController,
    AdminOrderOperationsController,
    AdminOrderController,
    LocationController,
  ],
})
export class OrdersModule {}
