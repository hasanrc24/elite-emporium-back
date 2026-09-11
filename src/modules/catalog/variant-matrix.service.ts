import { Op } from "sequelize";
import {
  Attribute,
  AttributeTranslation,
  AttributeValue,
  AttributeValueTranslation,
  IdempotencyRecord,
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  Product,
  ProductAttribute,
  ProductVariant,
  StockLocation,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256, signPayload, verifyPayload } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";

function cartesian(groups: RuntimeValue) {
  return groups.reduce(
    (rows: RuntimeValue, group: RuntimeValue) =>
      rows.flatMap((row: RuntimeValue) =>
        group.map((value: RuntimeValue) => [...row, value]),
      ),
    [[]],
  );
}

function valueLabel(value: RuntimeValue, locale: RuntimeValue) {
  return (
    value.translations?.find(
      (translation: RuntimeValue) => translation.locale === locale,
    )?.label || value.value
  );
}

function valueSignature(values: RuntimeValue) {
  return values
    .map((value: RuntimeValue) => `${value.attributeId}:${value.id}`)
    .sort()
    .join("|");
}

async function loadMatrixContext(
  productId: RuntimeValue,
  selections: RuntimeValue,
  transaction: RuntimeValue = null,
) {
  const product: RuntimeValue = await Product.findByPk(productId, {
    transaction,
  });
  if (!product) throw AppError.notFound("Product not found.");
  const attributeIds: RuntimeValue = selections.map(
    (item: RuntimeValue) => item.attributeId,
  );
  if (new Set(attributeIds).size !== attributeIds.length)
    throw AppError.unprocessable(
      "DUPLICATE_VARIATION_ATTRIBUTE",
      "Each variation attribute can be selected only once.",
    );
  const definitions: RuntimeValue = await ProductAttribute.findAll({
    where: {
      productId,
      attributeId: { [Op.in]: attributeIds },
      variation: true,
    },
    transaction,
  });
  if (definitions.length !== attributeIds.length)
    throw AppError.unprocessable(
      "INVALID_VARIATION_ATTRIBUTE",
      "Every selected attribute must be enabled for product variations.",
    );
  const attributes: RuntimeValue = await Attribute.findAll({
    where: {
      id: { [Op.in]: attributeIds },
      active: true,
      variationCapable: true,
    },
    include: [
      { model: AttributeTranslation, as: "translations" },
      {
        model: AttributeValue,
        as: "values",
        where: { active: true },
        required: false,
        include: [{ model: AttributeValueTranslation, as: "translations" }],
      },
    ],
    transaction,
  });
  if (attributes.length !== attributeIds.length)
    throw AppError.unprocessable(
      "INVALID_VARIATION_ATTRIBUTE",
      "One or more selected attributes are unavailable.",
    );
  const attributeById: RuntimeValue = new Map(
    attributes.map((attribute: RuntimeValue) => [attribute.id, attribute]),
  );
  const groups: RuntimeValue = selections.map((selection: RuntimeValue) => {
    const attribute: RuntimeValue = attributeById.get(selection.attributeId);
    const selectedIds = new Set(selection.valueIds);
    if (!selectedIds.size || selectedIds.size !== selection.valueIds.length)
      throw AppError.unprocessable(
        "INVALID_VARIATION_VALUES",
        "Select one or more unique values for every variation attribute.",
      );
    const values: RuntimeValue = attribute.values.filter(
      (value: RuntimeValue) => selectedIds.has(value.id),
    );
    if (values.length !== selectedIds.size)
      throw AppError.unprocessable(
        "INVALID_VARIATION_VALUES",
        "One or more variation values do not belong to the selected attribute.",
      );
    return values;
  });
  const combinationCount: RuntimeValue = groups.reduce(
    (total: RuntimeValue, group: RuntimeValue) => total * group.length,
    1,
  );
  if (combinationCount > 250)
    throw AppError.unprocessable(
      "VARIANT_MATRIX_TOO_LARGE",
      "A variant matrix can contain at most 250 combinations.",
    );
  return { product, attributes, groups };
}

export async function previewVariantMatrix(
  productId: RuntimeValue,
  payload: RuntimeValue,
) {
  const { product, attributes, groups }: RuntimeValue = await loadMatrixContext(
    productId,
    payload.attributes,
  );
  const existing: RuntimeValue = await ProductVariant.findAll({
    where: { productId },
    paranoid: false,
    include: [
      {
        model: AttributeValue,
        as: "attributeValues",
        through: { attributes: [] },
      },
    ],
  });
  const existingBySignature: RuntimeValue = new Map(
    existing.map((variant: RuntimeValue) => [
      valueSignature(variant.attributeValues || []),
      variant,
    ]),
  );
  const attributeById: RuntimeValue = new Map(
    attributes.map((attribute: RuntimeValue) => [attribute.id, attribute]),
  );
  const rows: RuntimeValue = cartesian(groups).map(
    (values: RuntimeValue, index: RuntimeValue) => {
      const signature: RuntimeValue = valueSignature(values);
      const existingVariant: RuntimeValue = existingBySignature.get(signature);
      const title: RuntimeValue = values
        .map((value: RuntimeValue) => valueLabel(value, payload.locale))
        .join(" / ");
      const skuParts: RuntimeValue = values.map((value: RuntimeValue) =>
        value.slug.toUpperCase().replace(/[^A-Z0-9]+/g, "-"),
      );
      return {
        clientKey: `matrix:${sha256(signature).slice(0, 20)}`,
        signature,
        existingVariantId: existingVariant?.id || null,
        attributeValueIds: values.map((value: RuntimeValue) => value.id),
        attributes: Object.fromEntries(
          values.map((value: RuntimeValue) => [
            attributeById.get(value.attributeId).key,
            value.value,
          ]),
        ),
        title,
        suggestedSku:
          existingVariant?.sku ||
          `${payload.skuPrefix}-${skuParts.join("-") || String(index + 1)}`.slice(
            0,
            100,
          ),
        existing: Boolean(existingVariant),
      };
    },
  );
  const expiresAt = new Date(Date.now() + 15 * 60000);
  const previewToken: RuntimeValue = signPayload({
    purpose: "variant_matrix",
    productId: product.id,
    productVersion: Number(product.version),
    signatures: rows.map((row: RuntimeValue) => row.signature),
    expiresAt: expiresAt.toISOString(),
  });
  return {
    productId: product.id,
    productVersion: Number(product.version),
    combinationCount: rows.length,
    rows,
    previewToken,
    expiresAt,
  };
}

function variantData(row: RuntimeValue) {
  return {
    sku: row.sku,
    barcode: row.barcode || null,
    title: row.title,
    attributes: row.attributes,
    combinationSignature: row.signature,
    regularPrice: row.regularPrice,
    salePrice: row.salePrice || null,
    costPrice: row.costPrice || null,
    saleStartsAt: row.saleStartsAt || null,
    saleEndsAt: row.saleEndsAt || null,
    stockPolicy: row.stockPolicy,
    preorderAvailableAt: row.preorderAvailableAt || null,
    preorderMessage: row.preorderMessage || null,
    weightGrams: row.weightGrams ?? null,
    dimensions: row.dimensions || null,
    status: "active",
    active: true,
  };
}

export async function commitVariantMatrix(
  productId: RuntimeValue,
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
  const token: RuntimeValue = verifyPayload(payload.previewToken);
  if (
    !token ||
    token.purpose !== "variant_matrix" ||
    token.productId !== productId ||
    new Date(token.expiresAt) <= new Date()
  )
    throw AppError.unprocessable(
      "VARIANT_PREVIEW_EXPIRED",
      "Generate a new variant preview before committing.",
    );
  const requestHash: RuntimeValue = sha256(canonicalJson(payload));
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const [idempotency]: RuntimeValue = await IdempotencyRecord.findOrCreate({
      where: {
        scope: "catalog.variant_matrix_commit",
        key: idempotencyKey,
        actorKey: actorId,
      },
      defaults: {
        id: newId(),
        scope: "catalog.variant_matrix_commit",
        key: idempotencyKey,
        actorKey: actorId,
        requestHash,
        expiresAt: new Date(Date.now() + 365 * 86400000),
      },
      transaction,
    });
    await idempotency.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (idempotency.requestHash !== requestHash)
      throw AppError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "This variant commit key was already used for different data.",
      );
    if (idempotency.responseBody) return idempotency.responseBody;
    const product: RuntimeValue = await Product.findByPk(productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw AppError.notFound("Product not found.");
    if (Number(product.version) !== Number(token.productVersion))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "The product changed after this preview. Generate it again.",
      );
    const allowed = new Set(token.signatures);
    if (
      !payload.rows.length ||
      payload.rows.some((row: RuntimeValue) => !allowed.has(row.signature)) ||
      new Set(payload.rows.map((row: RuntimeValue) => row.signature)).size !==
        payload.rows.length
    )
      throw AppError.unprocessable(
        "VARIANT_PREVIEW_MISMATCH",
        "Committed rows must come from the current preview.",
      );
    const existing: RuntimeValue = await ProductVariant.findAll({
      where: { productId },
      paranoid: false,
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingSignatures = new Set(
      existing
        .map((variant: RuntimeValue) => variant.combinationSignature)
        .filter(Boolean),
    );
    const valueIds: RuntimeValue = [
      ...new Set(
        payload.rows.flatMap((row: RuntimeValue) => row.attributeValueIds),
      ),
    ];
    const values: RuntimeValue = await AttributeValue.findAll({
      where: { id: { [Op.in]: valueIds }, active: true },
      transaction,
    });
    if (values.length !== valueIds.length)
      throw AppError.unprocessable(
        "INVALID_ATTRIBUTE_VALUE",
        "One or more variation values are unavailable.",
      );
    const location: RuntimeValue = await StockLocation.findOne({
      where: { active: true },
      order: [["createdAt", "ASC"]],
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    if (!location)
      throw AppError.unprocessable(
        "STOCK_LOCATION_REQUIRED",
        "Create an active stock location before adding variants.",
      );
    const hasDefault: RuntimeValue = existing.some(
      (variant: RuntimeValue) =>
        variant.isDefault && variant.active && variant.status === "active",
    );
    const created: RuntimeValue = [];
    const skipped: RuntimeValue = [];
    for (const row of payload.rows.sort(
      (left: RuntimeValue, right: RuntimeValue) =>
        left.signature.localeCompare(right.signature),
    )) {
      if (existingSignatures.has(row.signature)) {
        skipped.push(row.signature);
        continue;
      }
      const variant: RuntimeValue = await ProductVariant.create(
        {
          id: newId(),
          productId,
          ...variantData(row),
          isDefault: !hasDefault && created.length === 0,
          version: 1,
        },
        { transaction },
      );
      await variant.setAttributeValues(row.attributeValueIds, { transaction });
      const onHand: RuntimeValue = Number(row.initialStock || 0);
      await InventoryLevel.create(
        {
          id: newId(),
          variantId: variant.id,
          locationId: location.id,
          onHand,
          reserved: 0,
          lowStockThreshold: row.lowStockThreshold,
          version: 1,
        },
        { transaction },
      );
      if (onHand)
        await InventoryMovement.create(
          {
            id: newId(),
            variantId: variant.id,
            locationId: location.id,
            actorId,
            quantityDelta: onHand,
            reservedDelta: 0,
            onHandBefore: 0,
            balanceAfter: onHand,
            reservedAfter: 0,
            reason: "initial_stock",
            correlationId: idempotencyKey,
          },
          { transaction },
        );
      created.push({
        id: variant.id,
        sku: variant.sku,
        signature: row.signature,
      });
      existingSignatures.add(row.signature);
    }
    product.type =
      existing.filter(
        (variant: RuntimeValue) =>
          variant.active && variant.status === "active",
      ).length +
        created.length >
      1
        ? "variable"
        : product.type;
    product.version += 1;
    await product.save({ transaction });
    const response: RuntimeValue = {
      productId,
      productVersion: Number(product.version),
      created,
      skipped,
      createdCount: created.length,
      skippedCount: skipped.length,
    };
    idempotency.responseStatus = 201;
    idempotency.responseBody = response;
    await idempotency.save({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.variant_matrix_commit",
      resourceType: "product",
      resourceId: product.id,
      after: response,
      metadata: { idempotencyKey },
      request,
      transaction,
    });
    await addDomainEvent({
      topic: "catalog.product_updated",
      aggregateType: "product",
      aggregateId: product.id,
      payload: {
        productId: product.id,
        version: product.version,
        variantsCreated: created.length,
      },
      transaction,
    });
    return response;
  });
}

export async function updateVariant(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const variant: RuntimeValue = await ProductVariant.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!variant) throw AppError.notFound("Variant not found.");
    if (variant.deletedAt)
      throw AppError.conflict(
        "VARIANT_ARCHIVED",
        "Restore this variant before editing it.",
      );
    if (Number(payload.version) !== Number(variant.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This variant changed. Refresh and review the latest version.",
      );
    const product: RuntimeValue = await Product.findByPk(variant.productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const before: RuntimeValue = {
      sku: variant.sku,
      title: variant.title,
      regularPrice: moneyString(variant.regularPrice),
      salePrice:
        variant.salePrice == null ? null : moneyString(variant.salePrice),
      status: variant.status,
      version: variant.version,
    };
    await variant.update(
      {
        ...variantData({
          ...payload,
          signature: payload.signature || variant.combinationSignature,
        }),
        isDefault: payload.isDefault,
        version: variant.version + 1,
      },
      { transaction },
    );
    if (payload.attributeValueIds)
      await variant.setAttributeValues(payload.attributeValueIds, {
        transaction,
      });
    if (payload.isDefault) {
      await ProductVariant.update(
        { isDefault: false },
        {
          where: { productId: product.id, id: { [Op.ne]: variant.id } },
          transaction,
        },
      );
    }
    product.version += 1;
    await product.save({ transaction });
    const after: RuntimeValue = {
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      regularPrice: moneyString(variant.regularPrice),
      salePrice:
        variant.salePrice == null ? null : moneyString(variant.salePrice),
      status: variant.status,
      isDefault: variant.isDefault,
      version: variant.version,
      productVersion: product.version,
    };
    await recordAudit({
      actorId,
      action: "catalog.variant_update",
      resourceType: "product_variant",
      resourceId: variant.id,
      before,
      after,
      request,
      transaction,
    });
    return after;
  });
}

export async function archiveVariant(
  id: RuntimeValue,
  version: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const variant: RuntimeValue = await ProductVariant.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!variant) throw AppError.notFound("Variant not found.");
    if (Number(version) !== Number(variant.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This variant changed. Refresh and review the latest version.",
      );
    if (
      await InventoryReservation.count({
        where: {
          variantId: variant.id,
          status: { [Op.in]: ["active", "converted"] },
        },
        transaction,
      })
    )
      throw AppError.conflict(
        "VARIANT_HAS_RESERVATIONS",
        "This variant has active order reservations.",
      );
    const product: RuntimeValue = await Product.findByPk(variant.productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const activeSiblings: RuntimeValue = await ProductVariant.findAll({
      where: {
        productId: product.id,
        id: { [Op.ne]: variant.id },
        status: "active",
        active: true,
      },
      order: [["id", "ASC"]],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !activeSiblings.length &&
      ["published", "scheduled"].includes(product.status)
    )
      throw AppError.conflict(
        "PUBLISHED_PRODUCT_REQUIRES_VARIANT",
        "Unpublish the product before archiving its final active variant.",
      );
    const wasDefault = variant.isDefault;
    variant.status = "archived";
    variant.active = false;
    variant.isDefault = false;
    variant.version += 1;
    await variant.save({ transaction });
    if (wasDefault && activeSiblings[0]) {
      activeSiblings[0].isDefault = true;
      activeSiblings[0].version += 1;
      await activeSiblings[0].save({ transaction });
    }
    product.version += 1;
    await product.save({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.variant_archive",
      resourceType: "product_variant",
      resourceId: variant.id,
      after: { status: variant.status, productVersion: product.version },
      request,
      transaction,
    });
  });
}

export async function restoreVariant(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const variant: RuntimeValue = await ProductVariant.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!variant) throw AppError.notFound("Variant not found.");
    if (variant.deletedAt) await variant.restore({ transaction });
    if (variant.status === "active" && variant.active)
      throw AppError.conflict(
        "VARIANT_NOT_ARCHIVED",
        "This variant is already active.",
      );
    const product: RuntimeValue = await Product.findByPk(variant.productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const hasDefault: RuntimeValue = await ProductVariant.count({
      where: {
        productId: product.id,
        isDefault: true,
        active: true,
        status: "active",
      },
      transaction,
    });
    variant.status = "active";
    variant.active = true;
    variant.isDefault = !hasDefault;
    variant.version += 1;
    await variant.save({ transaction });
    product.version += 1;
    await product.save({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.variant_restore",
      resourceType: "product_variant",
      resourceId: variant.id,
      after: {
        status: variant.status,
        isDefault: variant.isDefault,
        productVersion: product.version,
      },
      request,
      transaction,
    });
    return {
      id: variant.id,
      status: variant.status,
      active: variant.active,
      isDefault: variant.isDefault,
      version: variant.version,
      productVersion: product.version,
    };
  });
}
