import { Global, Module } from "@nestjs/common";
import { ApplicationServices } from "./application-services.js";
import {
  AccessTokenGuard,
  CartContextGuard,
  ContactRateLimitGuard,
  GuestReturnRateLimitGuard,
  OptionalAccessTokenGuard,
  PermissionGuard,
  RequestOriginGuard,
  WishlistContextGuard,
} from "./request-security.js";

@Global()
@Module({
  providers: [
    ApplicationServices,
    AccessTokenGuard,
    CartContextGuard,
    ContactRateLimitGuard,
    GuestReturnRateLimitGuard,
    OptionalAccessTokenGuard,
    PermissionGuard,
    RequestOriginGuard,
    WishlistContextGuard,
  ],
  exports: [
    ApplicationServices,
    AccessTokenGuard,
    CartContextGuard,
    ContactRateLimitGuard,
    GuestReturnRateLimitGuard,
    OptionalAccessTokenGuard,
    PermissionGuard,
    RequestOriginGuard,
    WishlistContextGuard,
  ],
})
export class RoutingModule {}
