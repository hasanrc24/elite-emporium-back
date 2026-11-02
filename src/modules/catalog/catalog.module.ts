import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller.js";
import { AdminProductController } from "./admin-product.controller.js";
import { AdminSearchController } from "./search.controller.js";
import { AdminTaxonomyController } from "./taxonomy.controller.js";

@Module({
  controllers: [
    CatalogController,
    AdminProductController,
    AdminTaxonomyController,
    AdminSearchController,
  ],
})
export class CatalogModule {}
