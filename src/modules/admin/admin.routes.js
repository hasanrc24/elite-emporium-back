import { Router } from 'express';
import { fn, col, Op } from 'sequelize';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { InventoryLevel, Order, OrderItem, Product, ReturnRequest, User } from '../../db/models.js';
import { moneyString } from '../../lib/money.js';

export const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  const { from, to } = dashboardRange(req.query);
  const createdInRange = { createdAt: { [Op.between]: [from, to] } };
  const activeOrderStatuses = ['placed', 'confirmed', 'processing', 'completed'];
  const [orders, products, customers, lowStock, revenue, pendingReturns, orderTrend, orderStatuses, topProducts] = await Promise.all([
    Order.count({ where: createdInRange }), Product.count({ where: { status: 'published' } }), User.count({ where: { status: 'active', ...createdInRange } }),
    InventoryLevel.count({ where: sequelizeWhereLowStock() }),
    Order.findOne({ attributes: [[fn('COALESCE', fn('SUM', col('grandTotal')), 0), 'total']], where: { ...createdInRange, orderStatus: { [Op.in]: activeOrderStatuses } }, raw: true }),
    ReturnRequest.count({ where: { ...createdInRange, status: { [Op.in]: ['requested', 'under_review', 'approved', 'in_transit', 'received'] } } }),
    Order.findAll({
      attributes: [[fn('DATE', col('createdAt')), 'date'], [fn('COUNT', col('id')), 'orders'], [fn('COALESCE', fn('SUM', col('grandTotal')), 0), 'revenue']],
      where: { ...createdInRange, orderStatus: { [Op.in]: activeOrderStatuses } },
      group: [fn('DATE', col('createdAt'))], order: [[fn('DATE', col('createdAt')), 'ASC']], raw: true,
    }),
    Order.findAll({ attributes: ['orderStatus', [fn('COUNT', col('id')), 'count']], where: createdInRange, group: ['orderStatus'], raw: true }),
    OrderItem.findAll({
      attributes: ['productName', [fn('SUM', col('quantity')), 'quantity'], [fn('COALESCE', fn('SUM', col('lineTotal')), 0), 'revenue']],
      include: [{ model: Order, as: 'order', attributes: [], required: true, where: createdInRange }],
      group: ['productName'], order: [[fn('SUM', col('quantity')), 'DESC']], limit: 5, raw: true,
    }),
  ]);
  const revenueValue = moneyString(revenue?.total || 0);
  res.json({
    data: {
      orders, products, customers, lowStock, pendingReturns, revenue: revenueValue,
      averageOrderValue: orders ? moneyString(Number(revenueValue) / orders) : '0.00',
      orderTrend: orderTrend.map((row) => ({ date: row.date, orders: Number(row.orders), revenue: moneyString(row.revenue) })),
      orderStatuses: orderStatuses.map((row) => ({ status: row.orderStatus, count: Number(row.count) })),
      topProducts: topProducts.map((row) => ({ name: row.productName, quantity: Number(row.quantity), revenue: moneyString(row.revenue) })),
    },
    meta: { range: { from: from.toISOString(), to: to.toISOString(), timezone: 'Asia/Dhaka' } },
    requestId: req.id,
  });
});

function dashboardRange(query) {
  const now = new Date();
  const fallbackFrom = new Date(now);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - 29);
  fallbackFrom.setUTCHours(0, 0, 0, 0);
  const parsedFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? new Date(`${query.from}T00:00:00.000+06:00`) : fallbackFrom;
  const parsedTo = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? new Date(`${query.to}T23:59:59.999+06:00`) : now;
  if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime()) || parsedFrom > parsedTo) return { from: fallbackFrom, to: now };
  return { from: parsedFrom, to: parsedTo };
}

function sequelizeWhereLowStock() {
  return { onHand: { [Op.lte]: col('lowStockThreshold') } };
}
