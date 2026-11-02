import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { fn, col, Op } from "sequelize";
import type { Request, Response } from "express";
import {
  AccessTokenGuard,
  PermissionGuard,
  Permissions,
} from "../../app/request-security.js";
import {
  InventoryLevel,
  Order,
  OrderItem,
  Product,
  ReturnRequest,
  User,
} from "../../db/models.js";
import { money, moneyString } from "../../lib/money.js";

const openConfirmation = ["pending", "no_answer", "call_back", "wrong_number"];

/** Share of `part` in `whole` as a percentage with one decimal, or null. */
function percentage(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function dashboardRange(query: Request["query"]) {
  const now = new Date();
  const fallbackFrom = new Date(now);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - 29);
  fallbackFrom.setUTCHours(0, 0, 0, 0);
  const parsedFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ""))
    ? new Date(`${query.from}T00:00:00.000+06:00`)
    : fallbackFrom;
  const parsedTo = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ""))
    ? new Date(`${query.to}T23:59:59.999+06:00`)
    : now;
  if (
    Number.isNaN(parsedFrom.getTime()) ||
    Number.isNaN(parsedTo.getTime()) ||
    parsedFrom > parsedTo
  )
    return { from: fallbackFrom, to: now };
  return { from: parsedFrom, to: parsedTo };
}

function sequelizeWhereLowStock() {
  return { onHand: { [Op.lte]: col("lowStockThreshold") } };
}

@Controller("admin")
export class AdminController {
  constructor() {}

  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Permissions("dashboard.view")
  @Get("/dashboard")
  route0(@Req() request: Request, @Res() response: Response): Promise<unknown> {
    return (async (req, res) => {
      const { from, to } = dashboardRange(req.query);
      const createdInRange = { createdAt: { [Op.between]: [from, to] } };
      const activeOrderStatuses = [
        "placed",
        "confirmed",
        "processing",
        "completed",
      ];
      const [
        orders,
        products,
        customers,
        lowStock,
        revenue,
        pendingReturns,
        orderTrend,
        orderStatuses,
        topProducts,
        toConfirm,
        toPack,
        toShip,
        inTransit,
        fulfillmentOutcomes,
        confirmationOutcomes,
        channels,
      ] = await Promise.all([
        Order.count({ where: createdInRange }),
        Product.count({ where: { status: "published" } }),
        User.count({ where: { status: "active", ...createdInRange } }),
        InventoryLevel.count({ where: sequelizeWhereLowStock() }),
        Order.findOne({
          attributes: [
            [fn("COALESCE", fn("SUM", col("grandTotal")), 0), "total"],
          ],
          where: {
            ...createdInRange,
            orderStatus: { [Op.in]: activeOrderStatuses },
          },
          raw: true,
        }),
        ReturnRequest.count({
          where: {
            ...createdInRange,
            status: {
              [Op.in]: [
                "requested",
                "under_review",
                "approved",
                "in_transit",
                "received",
              ],
            },
          },
        }),
        Order.findAll({
          attributes: [
            [fn("DATE", col("createdAt")), "date"],
            [fn("COUNT", col("id")), "orders"],
            [fn("COALESCE", fn("SUM", col("grandTotal")), 0), "revenue"],
          ],
          where: {
            ...createdInRange,
            orderStatus: { [Op.in]: activeOrderStatuses },
          },
          group: [fn("DATE", col("createdAt"))],
          order: [[fn("DATE", col("createdAt")), "ASC"]],
          raw: true,
        }),
        Order.findAll({
          attributes: ["orderStatus", [fn("COUNT", col("id")), "count"]],
          where: createdInRange,
          group: ["orderStatus"],
          raw: true,
        }),
        OrderItem.findAll({
          attributes: [
            "productName",
            [fn("SUM", col("quantity")), "quantity"],
            [fn("COALESCE", fn("SUM", col("lineTotal")), 0), "revenue"],
          ],
          include: [
            {
              model: Order,
              as: "order",
              attributes: [],
              required: true,
              where: createdInRange,
            },
          ],
          group: ["productName"],
          order: [[fn("SUM", col("quantity")), "DESC"]],
          limit: 5,
          raw: true,
        }),
        Order.count({
          where: {
            orderStatus: "placed",
            confirmationStatus: { [Op.in]: openConfirmation },
          },
        }),
        Order.count({
          where: {
            orderStatus: { [Op.in]: ["placed", "confirmed", "processing"] },
            fulfillmentStatus: { [Op.in]: ["unfulfilled", "processing"] },
            confirmationStatus: { [Op.in]: ["confirmed", "not_required"] },
          },
        }),
        Order.count({ where: { fulfillmentStatus: "packed" } }),
        Order.count({
          where: {
            fulfillmentStatus: { [Op.in]: ["shipped", "out_for_delivery"] },
          },
        }),
        Order.findAll({
          attributes: ["fulfillmentStatus", [fn("COUNT", col("id")), "count"]],
          where: {
            ...createdInRange,
            fulfillmentStatus: {
              [Op.in]: [
                "delivered",
                "partially_returned",
                "returned",
                "returned_to_origin",
              ],
            },
          },
          group: ["fulfillmentStatus"],
          raw: true,
        }),
        Order.findAll({
          attributes: ["confirmationStatus", [fn("COUNT", col("id")), "count"]],
          where: {
            ...createdInRange,
            confirmationStatus: { [Op.ne]: "not_required" },
          },
          group: ["confirmationStatus"],
          raw: true,
        }),
        Order.findAll({
          attributes: ["channel", [fn("COUNT", col("id")), "count"]],
          where: createdInRange,
          group: ["channel"],
          raw: true,
        }),
      ]);
      const countOf = (rows: RuntimeValue[], key: string, value: string) =>
        Number(rows.find((row) => row[key] === value)?.count || 0);
      const returnedToOrigin = countOf(
        fulfillmentOutcomes,
        "fulfillmentStatus",
        "returned_to_origin",
      );
      const delivered = fulfillmentOutcomes
        .filter(
          (row: RuntimeValue) => row.fulfillmentStatus !== "returned_to_origin",
        )
        .reduce((sum: number, row: RuntimeValue) => sum + Number(row.count), 0);
      const confirmationTotal = confirmationOutcomes.reduce(
        (sum: number, row: RuntimeValue) => sum + Number(row.count),
        0,
      );
      const revenueValue = moneyString(revenue?.total || 0);
      res.json({
        data: {
          orders,
          products,
          customers,
          lowStock,
          pendingReturns,
          revenue: revenueValue,
          averageOrderValue: orders
            ? moneyString(money(revenueValue).dividedBy(orders))
            : "0.00",
          tasks: { toConfirm, toPack, toShip, inTransit },
          delivery: {
            delivered,
            returnedToOrigin,
            rtoRate: percentage(returnedToOrigin, delivered + returnedToOrigin),
          },
          confirmation: {
            confirmed: countOf(
              confirmationOutcomes,
              "confirmationStatus",
              "confirmed",
            ),
            total: confirmationTotal,
            confirmationRate: percentage(
              countOf(confirmationOutcomes, "confirmationStatus", "confirmed"),
              confirmationTotal,
            ),
          },
          channels: channels.map((row: RuntimeValue) => ({
            channel: row.channel,
            count: Number(row.count),
          })),
          orderTrend: orderTrend.map((row) => ({
            date: row.date,
            orders: Number(row.orders),
            revenue: moneyString(row.revenue),
          })),
          orderStatuses: orderStatuses.map((row) => ({
            status: row.orderStatus,
            count: Number(row.count),
          })),
          topProducts: topProducts.map((row) => ({
            name: row.productName,
            quantity: Number(row.quantity),
            revenue: moneyString(row.revenue),
          })),
        },
        meta: {
          range: {
            from: from.toISOString(),
            to: to.toISOString(),
            timezone: "Asia/Dhaka",
          },
        },
        requestId: req.id,
      });
    })(request, response);
  }
}
