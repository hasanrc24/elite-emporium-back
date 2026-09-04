import { DataTypes } from 'sequelize';

const ref = (table, allowNull = true, onDelete = 'SET NULL') => ({
  type: DataTypes.CHAR(26),
  allowNull,
  references: { model: table, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete,
});

/**
 * Expands the initial returns schema with operational identifiers and explicit
 * links needed to make refund/restock side effects idempotent and auditable.
 * The nullable/backfill/required sequence is safe when return rows already exist.
 */
export async function up({ context: queryInterface }) {
  await queryInterface.addColumn('return_requests', 'reference', {
    type: DataTypes.STRING(40),
    allowNull: true,
  });
  await queryInterface.sequelize.query(`
    UPDATE return_requests
    SET reference = CONCAT('RTN-', UPPER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 20)))
    WHERE reference IS NULL
  `);
  await queryInterface.changeColumn('return_requests', 'reference', {
    type: DataTypes.STRING(40),
    allowNull: false,
  });
  await queryInterface.addIndex('return_requests', ['reference'], {
    name: 'return_requests_reference_unique',
    unique: true,
  });

  await queryInterface.addColumn('return_requests', 'rejectionReason', DataTypes.STRING(500));
  await queryInterface.addColumn('return_requests', 'rejectedAt', DataTypes.DATE(3));
  await queryInterface.addColumn('return_requests', 'cancelledAt', DataTypes.DATE(3));

  await queryInterface.addColumn('return_items', 'restockLocationId', ref('stock_locations'));
  await queryInterface.addColumn('return_items', 'restockedAt', DataTypes.DATE(3));
  await queryInterface.addColumn('inventory_movements', 'returnId', ref('return_requests'));

  await queryInterface.addColumn('refunds', 'returnId', ref('return_requests'));
  await queryInterface.addIndex('refunds', ['returnId'], {
    name: 'refunds_return_unique',
    unique: true,
  });
}

export async function down({ context: queryInterface }) {
  await queryInterface.removeIndex('refunds', 'refunds_return_unique');
  await queryInterface.removeColumn('refunds', 'returnId');
  await queryInterface.removeColumn('inventory_movements', 'returnId');
  await queryInterface.removeColumn('return_items', 'restockedAt');
  await queryInterface.removeColumn('return_items', 'restockLocationId');
  await queryInterface.removeColumn('return_requests', 'cancelledAt');
  await queryInterface.removeColumn('return_requests', 'rejectedAt');
  await queryInterface.removeColumn('return_requests', 'rejectionReason');
  await queryInterface.removeIndex('return_requests', 'return_requests_reference_unique');
  await queryInterface.removeColumn('return_requests', 'reference');
}
