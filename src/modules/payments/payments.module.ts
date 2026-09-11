import { Module } from "@nestjs/common";
import { PaymentController } from "./payment.controller.js";
import { AdminRefundController } from "./refund.controller.js";

@Module({
  controllers: [PaymentController, AdminRefundController],
})
export class PaymentsModule {}
