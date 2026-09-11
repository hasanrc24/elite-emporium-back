import { Module } from "@nestjs/common";
import { AdminCouponController } from "./admin-coupon.controller.js";

@Module({
  controllers: [AdminCouponController],
})
export class PromotionsModule {}
