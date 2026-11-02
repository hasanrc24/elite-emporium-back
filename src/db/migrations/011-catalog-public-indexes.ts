import type { MigrationContext } from "./migration.types.js";

/**
 * Indexes for the public catalog paths: published listing by visibility and
 * recency, category browsing, variant filtering and approved-review lookups.
 */
const indexes: { table: string; name: string; fields: string[] }[] = [
  {
    table: "products",
    name: "products_public_listing_idx",
    fields: ["status", "visibility", "publishedAt"],
  },
  {
    table: "products",
    name: "products_category_status_idx",
    fields: ["categoryId", "status"],
  },
  {
    table: "product_variants",
    name: "product_variants_public_idx",
    fields: ["productId", "active", "status"],
  },
  {
    table: "reviews",
    name: "reviews_product_status_created_idx",
    fields: ["productId", "status", "createdAt"],
  },
];

export async function up({ context: queryInterface }: MigrationContext) {
  for (const index of indexes) {
    const existing = (await queryInterface.showIndex(index.table)) as {
      name: string;
    }[];
    if (existing.some((item) => item.name === index.name)) continue;
    await queryInterface.addIndex(index.table, index.fields, {
      name: index.name,
    });
  }
}

export async function down({ context: queryInterface }: MigrationContext) {
  for (const index of indexes)
    await queryInterface.removeIndex(index.table, index.name).catch(() => {});
}
