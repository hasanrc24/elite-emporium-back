import { Module } from "@nestjs/common";
import { CartController } from "./cart.controller.js";

@Module({ controllers: [CartController] })
export class CartModule {}
