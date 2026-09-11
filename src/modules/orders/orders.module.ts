import { Module } from "@nestjs/common";
import { CheckoutController, OrderController } from "./order.controller.js";
import { AdminOrderController } from "./admin-order.controller.js";

@Module({
  controllers: [CheckoutController, OrderController, AdminOrderController],
})
export class OrdersModule {}
