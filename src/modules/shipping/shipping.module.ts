import { Module } from "@nestjs/common";
import { AdminShippingController } from "./admin-shipping.controller.js";

@Module({
  controllers: [AdminShippingController],
})
export class ShippingModule {}
