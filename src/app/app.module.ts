import { Module } from "@nestjs/common";
import { CoreController } from "./core.controller.js";
import { InfrastructureModule } from "./infrastructure.module.js";
import { RoutingModule } from "./routing.module.js";
import { AdminModule } from "../modules/admin/admin.module.js";
import { AuthModule } from "../modules/auth/auth.module.js";
import { CartModule } from "../modules/cart/cart.module.js";
import { CatalogModule } from "../modules/catalog/catalog.module.js";
import { ContentModule } from "../modules/content/content.module.js";
import { IntegrationsModule } from "../modules/integrations/integrations.module.js";
import { InventoryModule } from "../modules/inventory/inventory.module.js";
import { MediaModule } from "../modules/media/media.module.js";
import { OrdersModule } from "../modules/orders/orders.module.js";
import { PaymentsModule } from "../modules/payments/payments.module.js";
import { PromotionsModule } from "../modules/promotions/promotions.module.js";
import { ReturnsModule } from "../modules/returns/returns.module.js";
import { ReviewsModule } from "../modules/reviews/reviews.module.js";
import { SettingsModule } from "../modules/settings/settings.module.js";
import { ShippingModule } from "../modules/shipping/shipping.module.js";
import { UsersModule } from "../modules/users/users.module.js";
import { WishlistModule } from "../modules/wishlist/wishlist.module.js";

@Module({
  imports: [
    RoutingModule,
    InfrastructureModule,
    AdminModule,
    AuthModule,
    CartModule,
    CatalogModule,
    ContentModule,
    IntegrationsModule,
    InventoryModule,
    MediaModule,
    OrdersModule,
    PaymentsModule,
    PromotionsModule,
    ReturnsModule,
    ReviewsModule,
    SettingsModule,
    ShippingModule,
    UsersModule,
    WishlistModule,
  ],
  controllers: [CoreController],
})
export class AppModule {}
