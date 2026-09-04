import { Router } from 'express';
import { fn, col, Op } from 'sequelize';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { InventoryLevel, Order, Product, User } from '../../db/models.js';
import { moneyString } from '../../lib/money.js';

export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  const [orders, products, customers, lowStock, revenue] = await Promise.all([
    Order.count(), Product.count({ where: { status: 'published' } }), User.count({ where: { status: 'active' } }),
    InventoryLevel.count({ where: sequelizeWhereLowStock() }),
    Order.findOne({ attributes: [[fn('COALESCE', fn('SUM', col('grandTotal')), 0), 'total']], where: { orderStatus: { [Op.in]: ['placed', 'confirmed', 'processing', 'completed'] } }, raw: true }),
  ]);
  res.json({ data: { orders, products, customers, lowStock, revenue: moneyString(revenue?.total || 0) }, meta: null, requestId: req.id });
});

function sequelizeWhereLowStock() {
  return { onHand: { [Op.lte]: col('lowStockThreshold') } };
}
