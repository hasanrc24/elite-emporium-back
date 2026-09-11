import { Module } from "@nestjs/common";
import {
  AdminReviewController,
  ReviewController,
} from "./review.controller.js";

@Module({
  controllers: [ReviewController, AdminReviewController],
})
export class ReviewsModule {}
