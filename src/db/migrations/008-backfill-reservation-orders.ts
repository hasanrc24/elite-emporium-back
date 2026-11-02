import type { MigrationContext } from "./migration.types.js";

/**
 * Reservations were written without `orderId` because the model lacked the
 * association, so packing never consumed stock and cancellations never
 * released it. The matching `order_reserved` ledger rows carry the order ID
 * and the same correlation key, which lets us restore the link. Stock levels
 * are not changed here; staff reconcile counts after deploying (see docs).
 */
export async function up({ context: queryInterface }: MigrationContext) {
  await queryInterface.sequelize.query(`
    UPDATE inventory_reservations r
    JOIN inventory_movements m
      ON m.correlationId = r.idempotencyKey
     AND m.variantId = r.variantId
     AND m.locationId = r.locationId
     AND m.reason = 'order_reserved'
     AND m.orderId IS NOT NULL
    SET r.orderId = m.orderId
    WHERE r.orderId IS NULL
  `);
}

export async function down() {
  // Restored links are correct data; there is nothing to undo.
}
