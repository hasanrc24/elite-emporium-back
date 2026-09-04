import { DataTypes } from 'sequelize';

const tableOptions = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };
const id = () => ({ type: DataTypes.CHAR(26), allowNull: false, primaryKey: true });
const ref = (table, allowNull = false) => ({ type: DataTypes.CHAR(26), allowNull, references: { model: table, key: 'id' }, onUpdate: 'CASCADE', onDelete: allowNull ? 'SET NULL' : 'RESTRICT' });

export async function up({ context: queryInterface }) {
  await queryInterface.addColumn('roles', 'version', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 });
  await queryInterface.createTable('customer_notes', {
    id: id(),
    userId: ref('users'),
    actorId: ref('users'),
    category: { type: DataTypes.ENUM('support', 'risk', 'operations'), allowNull: false, defaultValue: 'support' },
    message: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
  }, tableOptions);
  await queryInterface.createTable('privacy_requests', {
    id: id(),
    userId: ref('users'),
    type: { type: DataTypes.ENUM('export', 'deletion'), allowNull: false },
    status: { type: DataTypes.ENUM('requested', 'under_review', 'approved', 'rejected', 'completed'), allowNull: false, defaultValue: 'requested' },
    activeKey: { type: DataTypes.STRING(80), unique: true },
    requestedAt: { type: DataTypes.DATE(3), allowNull: false },
    reviewedBy: ref('users', true),
    reviewedAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    reason: DataTypes.STRING(500),
    metadata: DataTypes.JSON,
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  }, tableOptions);
  await queryInterface.addIndex('customer_notes', ['userId', 'createdAt']);
  await queryInterface.addIndex('privacy_requests', ['status', 'createdAt']);
  await queryInterface.addColumn('export_jobs', 'privacyRequestId', {
    ...ref('privacy_requests', true),
    unique: true,
  });
}

export async function down({ context: queryInterface }) {
  await queryInterface.removeColumn('export_jobs', 'privacyRequestId');
  await queryInterface.dropTable('privacy_requests');
  await queryInterface.dropTable('customer_notes');
  await queryInterface.removeColumn('roles', 'version');
}
