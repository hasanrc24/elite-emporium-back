import { literal, Op } from "sequelize";
import {
  IdempotencyRecord,
  InventoryLevel,
  InventoryMovement,
  Product,
  ProductTranslation,
  ProductVariant,
  StockLocation,
  User,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { queueLowStockAlert } from "../notifications/staff-notification.service.js";

function levelDto(level: RuntimeValue) {
  return {
    id: level.id,
    variantId: level.variantId,
    sku: level.variant?.sku,
    variantTitle: level.variant?.title,
    product: level.variant?.product
      ? {
          id: level.variant.product.id,
          slug: level.variant.product.slug,
          name:
            level.variant.product.translations?.find(
              (item: RuntimeValue) => item.locale === "en",
            )?.name || level.variant.product.slug,
        }
      : null,
    location: level.location
      ? {
          id: level.location.id,
          code: level.location.code,
          name: level.location.name,
        }
      : null,
    onHand: Number(level.onHand),
    reserved: Number(level.reserved),
    available: Math.max(0, Number(level.onHand) - Number(level.reserved)),
    lowStockThreshold: Number(level.lowStockThreshold),
    lowStock:
      Number(level.onHand) - Number(level.reserved) <=
      Number(level.lowStockThreshold),
    version: Number(level.version),
    updatedAt: level.updatedAt,
  };
}

export async function listLevels(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.lowStock === "true")
    where[Op.and] = [
      literal(
        "(`InventoryLevel`.`onHand` - `InventoryLevel`.`reserved`) <= `InventoryLevel`.`lowStockThreshold`",
      ),
    ];
  if (query.search) {
    // Filter with EXISTS on the level row itself: nested `$...$` references
    // break once Sequelize wraps the paginated query in a subquery.
    const term: RuntimeValue = sequelize.escape(
      likeContains(query.search, 100),
    );
    where[Op.and] = [
      ...(where[Op.and] || []),
      literal(
        `EXISTS (SELECT 1 FROM product_variants pv LEFT JOIN product_translations pt ON pt.productId = pv.productId WHERE pv.id = \`InventoryLevel\`.\`variantId\` AND (pv.sku LIKE ${term} OR pt.name LIKE ${term}))`,
      ),
    ];
  }
  const include: RuntimeValue = [];
  include.push({ model: StockLocation, as: "location" });
  include.push({
    model: ProductVariant,
    as: "variant",
    include: [
      {
        model: Product,
        as: "product",
        include: [{ model: ProductTranslation, as: "translations" }],
      },
    ],
  });
  const result: RuntimeValue = await InventoryLevel.findAndCountAll({
    where,
    include,
    distinct: true,
    limit,
    offset,
    order: [["updatedAt", "DESC"]],
  });
  return {
    data: result.rows.map(levelDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function listMovements(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.variantId) where.variantId = query.variantId;
  if (query.locationId) where.locationId = query.locationId;
  if (query.reason) where.reason = query.reason;
  const result: RuntimeValue = await InventoryMovement.findAndCountAll({
    where,
    include: [
      {
        model: ProductVariant,
        as: "variant",
        attributes: ["id", "sku", "title"],
      },
      {
        model: StockLocation,
        as: "location",
        attributes: ["id", "code", "name"],
      },
      { model: User, as: "actor", attributes: ["id", "name"] },
    ],
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => ({
      id: row.id,
      variant: row.variant,
      location: row.location,
      quantityDelta: Number(row.quantityDelta),
      reservedDelta: Number(row.reservedDelta),
      onHandBefore: Number(row.onHandBefore),
      onHandAfter: Number(row.balanceAfter),
      reservedAfter: Number(row.reservedAfter),
      reason: row.reason,
      note: row.note,
      actor: row.actor,
      orderId: row.orderId,
      correlationId: row.correlationId,
      createdAt: row.createdAt,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function adjustInventory(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue,
) {
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  const requestHash: RuntimeValue = sha256(canonicalJson(payload));
  const actorKey = actorId;
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const [record]: RuntimeValue = await IdempotencyRecord.findOrCreate({
      where: { scope: "inventory.adjust", key: idempotencyKey, actorKey },
      defaults: {
        id: newId(),
        scope: "inventory.adjust",
        key: idempotencyKey,
        actorKey,
        requestHash,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
      transaction,
    });
    await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (record.requestHash !== requestHash)
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This inventory key was already used for a different adjustment.",
      );
    if (record.responseBody) return record.responseBody;
    const [variant, location]: RuntimeValue = await Promise.all([
      ProductVariant.findByPk(payload.variantId, {
        paranoid: false,
        transaction,
      }),
      StockLocation.findOne({
        where: { id: payload.locationId, active: true },
        transaction,
      }),
    ]);
    if (!variant) throw AppError.notFound("Product variant not found.");
    if (!location)
      throw AppError.unprocessable(
        "INVALID_STOCK_LOCATION",
        "Choose an active stock location.",
      );
    const [level]: RuntimeValue = await InventoryLevel.findOrCreate({
      where: { variantId: variant.id, locationId: location.id },
      defaults: {
        id: newId(),
        variantId: variant.id,
        locationId: location.id,
        onHand: 0,
        reserved: 0,
        lowStockThreshold: payload.lowStockThreshold ?? 3,
        version: 1,
      },
      transaction,
    });
    await level.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (Number(payload.version) !== Number(level.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "Inventory changed. Refresh and review the latest balance.",
      );
    const before: RuntimeValue = levelDto(level);
    const delta: RuntimeValue =
      payload.countedQuantity == null
        ? Number(payload.delta)
        : Number(payload.countedQuantity) - Number(level.onHand);
    const nextOnHand = Number(level.onHand) + delta;
    if (nextOnHand < 0)
      throw AppError.unprocessable(
        "NEGATIVE_INVENTORY",
        "This adjustment would make on-hand inventory negative.",
      );
    level.onHand = nextOnHand;
    if (payload.lowStockThreshold != null) {
      // An explicit threshold becomes this variant's own (most specific) one.
      level.lowStockThreshold = payload.lowStockThreshold;
      await ProductVariant.update(
        { lowStockThreshold: payload.lowStockThreshold },
        { where: { id: variant.id }, transaction },
      );
    }
    level.version += 1;
    await level.save({ transaction });
    await InventoryMovement.create(
      {
        id: newId(),
        variantId: variant.id,
        locationId: location.id,
        actorId,
        quantityDelta: delta,
        reservedDelta: 0,
        onHandBefore: before.onHand,
        balanceAfter: nextOnHand,
        reservedAfter: Number(level.reserved),
        reason: payload.reason,
        note: payload.note || null,
        correlationId: idempotencyKey,
      },
      { transaction },
    );
    const response: RuntimeValue = levelDto({
      ...level.get(),
      variant,
      location,
    });
    await recordAudit({
      actorId,
      action: "inventory.adjust",
      resourceType: "inventory_level",
      resourceId: level.id,
      before,
      after: response,
      metadata: { reason: payload.reason, idempotencyKey },
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "inventory.adjusted",
      aggregateType: "inventory_level",
      aggregateId: level.id,
      payload: {
        variantId: variant.id,
        locationId: location.id,
        delta,
        onHand: nextOnHand,
        reserved: Number(level.reserved),
      },
      transaction,
    });
    if (nextOnHand - Number(level.reserved) <= Number(level.lowStockThreshold))
      await queueLowStockAlert({
        variantId: variant.id,
        sku: variant.sku,
        available: nextOnHand - Number(level.reserved),
        threshold: Number(level.lowStockThreshold),
        transaction,
      });
    record.responseStatus = 200;
    record.responseBody = response;
    await record.save({ transaction });
    return response;
  });
}

export async function listLocations() {
  const rows: RuntimeValue = await StockLocation.findAll({
    order: [
      ["active", "DESC"],
      ["createdAt", "ASC"],
    ],
  });
  return rows.map((row: RuntimeValue) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function createLocation(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await StockLocation.create(
      { id: newId(), ...payload, version: 1 },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "inventory.location_create",
      resourceType: "stock_location",
      resourceId: row.id,
      after: payload,
      request,
      transaction,
    });
    return row;
  });
}

export async function updateLocation(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await StockLocation.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Stock location not found.");
    if (Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This stock location changed. Refresh and try again.",
      );
    const before: RuntimeValue = row.toJSON();
    await row.update(
      {
        code: payload.code,
        name: payload.name,
        address: payload.address || null,
        active: payload.active,
        version: row.version + 1,
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "inventory.location_update",
      resourceType: "stock_location",
      resourceId: row.id,
      before,
      after: row.toJSON(),
      request,
      transaction,
    });
    return row;
  });
}
