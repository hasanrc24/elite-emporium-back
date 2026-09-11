import { Module } from "@nestjs/common";
import { WishlistController } from "./wishlist.controller.js";

@Module({
  controllers: [WishlistController],
})
export class WishlistModule {}
