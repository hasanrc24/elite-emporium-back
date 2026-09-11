import { Module } from "@nestjs/common";
import {
  AdminCatalogController,
  CatalogController,
} from "./catalog.controller.js";
import { AdminProductController } from "./admin-product.controller.js";
import { AdminTaxonomyController } from "./taxonomy.controller.js";

@Module({
  controllers: [
    CatalogController,
    AdminCatalogController,
    AdminProductController,
    AdminTaxonomyController,
  ],
})
export class CatalogModule {}
