import { Op } from "sequelize";
import {
  Order,
  Shipment,
  ShipmentEvent,
  ShippingMethod,
  ShippingZone,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { dateRangeWhere } from "../../lib/date-range.js";
import { recordAudit } from "../audits/audit.service.js";

function safeTrackingUrl(input: RuntimeValue) {
  if (!input) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw AppError.unprocessable(
      "INVALID_TRACKING_URL",
      "Enter a valid HTTPS tracking URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    input.length > 1000
  )
    throw AppError.unprocessable(
      "INVALID_TRACKING_URL",
      "Enter a credential-free HTTPS tracking URL.",
    );
  return url.toString();
}

function zoneDto(row: RuntimeValue) {
  return {
    id: row.id,
    code: row.code,
    nameEn: row.nameEn,
    nameBn: row.nameBn,
    matchMode: row.matchMode,
    rules: row.rules,
    priority: row.priority,
    active: row.active,
    version: row.version,
    archivedAt: row.deletedAt || null,
  };
}
function methodDto(row: RuntimeValue) {
  return {
    id: row.id,
    zoneId: row.zoneId,
    code: row.code,
    type: row.type,
    labelEn: row.labelEn,
    labelBn: row.labelBn,
    flatRate: moneyString(row.flatRate),
    freeThreshold:
      row.freeThreshold == null ? null : moneyString(row.freeThreshold),
    allowedPayments: row.allowedPayments || [],
    active: row.active,
    displayOrder: row.displayOrder,
    version: row.version,
    archivedAt: row.deletedAt || null,
  };
}

export async function listShippingConfiguration() {
  const [zones, methods]: RuntimeValue = await Promise.all([
    ShippingZone.findAll({ paranoid: false, order: [["priority", "ASC"]] }),
    ShippingMethod.findAll({
      paranoid: false,
      order: [["displayOrder", "ASC"]],
    }),
  ]);
  return { zones: zones.map(zoneDto), methods: methods.map(methodDto) };
}

export async function saveZone(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = id
      ? await ShippingZone.findByPk(id, {
          paranoid: false,
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    if (id && !row) throw AppError.notFound("Shipping zone not found.");
    if (row?.deletedAt)
      throw AppError.conflict(
        "RESOURCE_ARCHIVED",
        "Restore this shipping zone before editing it.",
      );
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This shipping zone changed. Refresh and try again.",
      );
    const before: RuntimeValue = row ? zoneDto(row) : null;
    if (!row)
      row = await ShippingZone.create(
        { id: newId(), ...payload, version: 1 },
        { transaction },
      );
    else
      await row.update(
        { ...payload, version: row.version + 1 },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: id ? "shipping.zone_update" : "shipping.zone_create",
      resourceType: "shipping_zone",
      resourceId: row.id,
      before,
      after: zoneDto(row),
      request,
      transaction,
    });
    return zoneDto(row);
  });
}

export async function saveMethod(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const zone: RuntimeValue = await ShippingZone.findOne({
      where: { id: payload.zoneId, active: true },
      transaction,
    });
    if (!zone)
      throw AppError.unprocessable(
        "INVALID_SHIPPING_ZONE",
        "Choose an active shipping zone.",
      );
    let row: RuntimeValue = id
      ? await ShippingMethod.findByPk(id, {
          paranoid: false,
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    if (id && !row) throw AppError.notFound("Shipping method not found.");
    if (row?.deletedAt)
      throw AppError.conflict(
        "RESOURCE_ARCHIVED",
        "Restore this shipping method before editing it.",
      );
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This shipping method changed. Refresh and try again.",
      );
    const before: RuntimeValue = row ? methodDto(row) : null;
    if (!row)
      row = await ShippingMethod.create(
        { id: newId(), ...payload, version: 1 },
        { transaction },
      );
    else
      await row.update(
        { ...payload, version: row.version + 1 },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: id ? "shipping.method_update" : "shipping.method_create",
      resourceType: "shipping_method",
      resourceId: row.id,
      before,
      after: methodDto(row),
      request,
      transaction,
    });
    return methodDto(row);
  });
}

export async function archiveShippingResource(
  kind: RuntimeValue,
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const model = kind === "zone" ? ShippingZone : ShippingMethod;
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await model.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Shipping resource not found.");
    if (
      kind === "zone" &&
      (await ShippingMethod.count({
        where: { zoneId: id, active: true },
        transaction,
      }))
    )
      throw AppError.conflict(
        "ZONE_HAS_METHODS",
        "Disable or archive this zone’s shipping methods first.",
      );
    row.active = false;
    row.version += 1;
    await row.save({ transaction });
    await row.destroy({ transaction });
    await recordAudit({
      actorId,
      action: `shipping.${kind}_archive`,
      resourceType: `shipping_${kind}`,
      resourceId: id,
      request,
      transaction,
    });
  });
}

export async function restoreShippingResource(
  kind: RuntimeValue,
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const model = kind === "zone" ? ShippingZone : ShippingMethod;
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await model.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row?.deletedAt)
      throw AppError.notFound("Archived shipping resource not found.");
    await row.restore({ transaction });
    row.version += 1;
    await row.save({ transaction });
    await recordAudit({
      actorId,
      action: `shipping.${kind}_restore`,
      resourceType: `shipping_${kind}`,
      resourceId: id,
      request,
      transaction,
    });
    return kind === "zone" ? zoneDto(row) : methodDto(row);
  });
}

function shipmentDto(row: RuntimeValue) {
  return {
    id: row.id,
    orderId: row.orderId,
    orderReference: row.order?.reference,
    provider: row.provider,
    courierName: row.courierName,
    consignmentId: row.consignmentId,
    trackingUrl: row.trackingUrl,
    fee: row.fee == null ? null : moneyString(row.fee),
    status: row.status,
    labelMediaId: row.labelMediaId,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    version: row.version,
    events:
      row.events?.map((event: RuntimeValue) => ({
        id: event.id,
        type: event.type,
        message: event.message,
        createdAt: event.createdAt,
      })) || [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listShipments(query: RuntimeValue) {
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  Object.assign(where, dateRangeWhere(query));
  const rows: RuntimeValue = await Shipment.findAll({
    where,
    include: [
      {
        model: Order,
        as: "order",
        where: query.search
          ? {
              reference: {
                [Op.like]: `%${String(query.search).slice(0, 80)}%`,
              },
            }
          : undefined,
      },
      { model: ShipmentEvent, as: "events" },
    ],
    order: [["createdAt", "DESC"]],
    limit: Math.min(200, Math.max(1, Number(query.limit) || 50)),
  });
  return rows.map(shipmentDto);
}

export async function createShipment(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const order: RuntimeValue = await Order.findByPk(payload.orderId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw AppError.notFound("Order not found.");
    if (["cancelled", "failed"].includes(order.orderStatus))
      throw AppError.conflict(
        "ORDER_NOT_SHIPPABLE",
        "This order cannot be shipped.",
      );
    const row: RuntimeValue = await Shipment.create(
      {
        id: newId(),
        orderId: order.id,
        provider: payload.provider || "manual",
        courierName: payload.courierName,
        consignmentId: payload.consignmentId || null,
        trackingUrl: safeTrackingUrl(payload.trackingUrl),
        fee: payload.fee || null,
        status: "created",
        labelMediaId: payload.labelMediaId || null,
        version: 1,
      },
      { transaction },
    );
    await ShipmentEvent.create(
      {
        id: newId(),
        shipmentId: row.id,
        type: "created",
        message: "Shipment created.",
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "shipping.shipment_create",
      resourceType: "shipment",
      resourceId: row.id,
      after: shipmentDto(row),
      request,
      transaction,
    });
    return shipmentDto(row);
  });
}

const shipmentTransitions: RuntimeValue = {
  draft: ["created", "cancelled"],
  created: ["picked_up", "cancelled", "failed"],
  picked_up: ["in_transit", "failed"],
  in_transit: ["out_for_delivery", "delivered", "failed"],
  out_for_delivery: ["delivered", "failed"],
  delivered: [],
  cancelled: [],
  failed: [],
};

export async function updateShipment(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await Shipment.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Shipment not found.");
    if (Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This shipment changed. Refresh and try again.",
      );
    if (
      payload.status &&
      payload.status !== row.status &&
      !shipmentTransitions[row.status]?.includes(payload.status)
    )
      throw AppError.conflict(
        "INVALID_SHIPMENT_TRANSITION",
        `Shipment cannot move from ${row.status} to ${payload.status}.`,
      );
    const before: RuntimeValue = shipmentDto(row);
    if (payload.status) row.status = payload.status;
    if (payload.courierName !== undefined)
      row.courierName = payload.courierName;
    if (payload.consignmentId !== undefined)
      row.consignmentId = payload.consignmentId || null;
    if (payload.trackingUrl !== undefined)
      row.trackingUrl = safeTrackingUrl(payload.trackingUrl);
    if (payload.fee !== undefined) row.fee = payload.fee || null;
    if (row.status === "picked_up" && !row.shippedAt)
      row.shippedAt = new Date();
    if (row.status === "delivered" && !row.deliveredAt)
      row.deliveredAt = new Date();
    row.version += 1;
    await row.save({ transaction });
    await ShipmentEvent.create(
      {
        id: newId(),
        shipmentId: row.id,
        type: payload.status ? "status_changed" : "updated",
        message:
          payload.message ||
          (payload.status
            ? `Shipment status changed to ${payload.status}.`
            : "Shipment updated."),
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "shipping.shipment_update",
      resourceType: "shipment",
      resourceId: row.id,
      before,
      after: shipmentDto(row),
      request,
      transaction,
    });
    return shipmentDto(row);
  });
}
