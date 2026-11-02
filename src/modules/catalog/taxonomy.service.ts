import { literal, Op } from "sequelize";
import {
  Attribute,
  AttributeTranslation,
  AttributeValue,
  AttributeValueTranslation,
  Brand,
  BrandTranslation,
  Category,
  CategoryTranslation,
  Collection,
  CollectionTranslation,
  MediaAsset,
  Product,
  ProductAttribute,
  ProductVariant,
  SizeChart,
  SizeChartRow,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";

const definitions: RuntimeValue = {
  categories: {
    model: Category,
    translation: CategoryTranslation,
    foreignKey: "categoryId",
    mediaKey: "imageId",
    mediaAlias: "image",
  },
  collections: {
    model: Collection,
    translation: CollectionTranslation,
    foreignKey: "collectionId",
    mediaKey: "imageId",
    mediaAlias: "image",
  },
  brands: {
    model: Brand,
    translation: BrandTranslation,
    foreignKey: "brandId",
    mediaKey: "logoId",
    mediaAlias: "logo",
  },
};

function definition(kind: RuntimeValue) {
  const value = definitions[kind];
  if (!value) throw new Error(`Unsupported taxonomy: ${kind}`);
  return value;
}

function includeFor(kind: RuntimeValue) {
  const value: RuntimeValue = definition(kind);
  return [
    { model: value.translation, as: "translations" },
    { model: MediaAsset, as: value.mediaAlias, required: false },
  ];
}

function dto(entity: RuntimeValue, kind: RuntimeValue) {
  const value: RuntimeValue = definition(kind);
  return {
    id: entity.id,
    slug: entity.slug,
    active: entity.active,
    displayOrder: entity.displayOrder,
    parentId: kind === "categories" ? entity.parentId : undefined,
    startsAt: kind === "collections" ? entity.startsAt : undefined,
    endsAt: kind === "collections" ? entity.endsAt : undefined,
    mediaId: entity[value.mediaKey] || null,
    translations: Object.fromEntries(
      (entity.translations || []).map((item: RuntimeValue) => [
        item.locale,
        {
          name: item.name,
          description: item.description || "",
          seoTitle: item.seoTitle || null,
          seoDescription: item.seoDescription || null,
        },
      ]),
    ),
    version: entity.version,
    archivedAt: entity.deletedAt || null,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

async function validateMedia(mediaId: RuntimeValue, transaction: RuntimeValue) {
  if (!mediaId) return;
  const media: RuntimeValue = await MediaAsset.findOne({
    where: { id: mediaId, status: "ready", privacy: "public" },
    transaction,
  });
  if (!media)
    throw AppError.unprocessable(
      "INVALID_MEDIA",
      "Choose a public media asset that has finished processing.",
    );
}

async function validateCategoryParent(
  id: RuntimeValue,
  parentId: RuntimeValue,
  transaction: RuntimeValue,
) {
  if (!parentId) return;
  if (id === parentId)
    throw AppError.unprocessable(
      "CATEGORY_CYCLE",
      "A category cannot be its own parent.",
    );
  let current: RuntimeValue = await Category.findByPk(parentId, {
    paranoid: false,
    transaction,
  });
  if (!current)
    throw AppError.unprocessable(
      "INVALID_PARENT",
      "Parent category does not exist.",
    );
  for (let depth = 0; current?.parentId && depth < 100; depth += 1) {
    if (current.parentId === id)
      throw AppError.unprocessable(
        "CATEGORY_CYCLE",
        "Category hierarchy cannot contain a cycle.",
      );
    current = await Category.findByPk(current.parentId, {
      paranoid: false,
      transaction,
    });
  }
}

async function saveTranslations(
  entityId: RuntimeValue,
  payload: RuntimeValue,
  value: RuntimeValue,
  transaction: RuntimeValue,
) {
  for (const locale of ["en", "bn"]) {
    const [row]: RuntimeValue = await value.translation.findOrCreate({
      where: { [value.foreignKey]: entityId, locale },
      defaults: {
        id: newId(),
        [value.foreignKey]: entityId,
        locale,
        ...payload[locale],
      },
      transaction,
    });
    if (!row.isNewRecord) await row.update(payload[locale], { transaction });
  }
}

export async function listTaxonomies(kind: RuntimeValue, query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const value: RuntimeValue = definition(kind);
  const where: RuntimeValue = {};
  if (query.status === "active") {
    where.active = true;
    where.deletedAt = null;
  }
  if (query.status === "archived") where.deletedAt = { [Op.ne]: null };
  if (query.search) {
    // EXISTS keeps the filter valid inside Sequelize's LIMIT subquery, where
    // the hasMany translations join is not available.
    const term: RuntimeValue = likeContains(query.search, 80);
    where[Op.or] = [
      { slug: { [Op.like]: term } },
      literal(
        `EXISTS (SELECT 1 FROM ${value.translation.getTableName()} t WHERE t.${value.foreignKey} = ${value.model.name}.id AND t.name LIKE ${sequelize.escape(term)})`,
      ),
    ];
  }
  const result: RuntimeValue = await value.model.findAndCountAll({
    where,
    paranoid: false,
    include: includeFor(kind),
    distinct: true,
    limit,
    offset,
    order: [
      ["displayOrder", "ASC"],
      ["createdAt", "DESC"],
    ],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => dto(row, kind)),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getTaxonomy(kind: RuntimeValue, id: RuntimeValue) {
  const row: RuntimeValue = await definition(kind).model.findByPk(id, {
    paranoid: false,
    include: includeFor(kind),
  });
  if (!row) throw AppError.notFound("Taxonomy record not found.");
  return dto(row, kind);
}

export async function createTaxonomy(
  kind: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const value: RuntimeValue = definition(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    await validateMedia(payload.mediaId, transaction);
    if (kind === "categories")
      await validateCategoryParent(null, payload.parentId, transaction);
    const row: RuntimeValue = await value.model.create(
      {
        id: newId(),
        slug: payload.slug,
        active: payload.active,
        displayOrder: payload.displayOrder,
        [value.mediaKey]: payload.mediaId || null,
        ...(kind === "categories"
          ? { parentId: payload.parentId || null }
          : {}),
        ...(kind === "collections"
          ? {
              startsAt: payload.startsAt || null,
              endsAt: payload.endsAt || null,
            }
          : {}),
        version: 1,
      },
      { transaction },
    );
    await saveTranslations(row.id, payload.translations, value, transaction);
    await recordAudit({
      actorId,
      action: `catalog.${kind}.create`,
      resourceType: kind.slice(0, -1),
      resourceId: row.id,
      after: payload,
      request,
      transaction,
    });
    return getTaxonomyWithinTransaction(kind, row.id, transaction);
  });
}

async function getTaxonomyWithinTransaction(
  kind: RuntimeValue,
  id: RuntimeValue,
  transaction: RuntimeValue,
) {
  const row: RuntimeValue = await definition(kind).model.findByPk(id, {
    paranoid: false,
    include: includeFor(kind),
    transaction,
  });
  return dto(row, kind);
}

export async function updateTaxonomy(
  kind: RuntimeValue,
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const value: RuntimeValue = definition(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await value.model.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Taxonomy record not found.");
    if (row.deletedAt)
      throw AppError.conflict(
        "RESOURCE_ARCHIVED",
        "Restore this record before editing it.",
      );
    if (Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This record changed. Refresh and review the latest version.",
      );
    await validateMedia(payload.mediaId, transaction);
    if (kind === "categories")
      await validateCategoryParent(row.id, payload.parentId, transaction);
    const before: RuntimeValue = await getTaxonomyWithinTransaction(
      kind,
      id,
      transaction,
    );
    await row.update(
      {
        slug: payload.slug,
        active: payload.active,
        displayOrder: payload.displayOrder,
        [value.mediaKey]: payload.mediaId || null,
        ...(kind === "categories"
          ? { parentId: payload.parentId || null }
          : {}),
        ...(kind === "collections"
          ? {
              startsAt: payload.startsAt || null,
              endsAt: payload.endsAt || null,
            }
          : {}),
        version: row.version + 1,
      },
      { transaction },
    );
    await saveTranslations(row.id, payload.translations, value, transaction);
    const after: RuntimeValue = await getTaxonomyWithinTransaction(
      kind,
      id,
      transaction,
    );
    await recordAudit({
      actorId,
      action: `catalog.${kind}.update`,
      resourceType: kind.slice(0, -1),
      resourceId: row.id,
      before,
      after,
      request,
      transaction,
    });
    return after;
  });
}

export async function archiveTaxonomy(
  kind: RuntimeValue,
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const value: RuntimeValue = definition(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await value.model.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound("Taxonomy record not found.");
    if (
      kind === "categories" &&
      (await Category.count({ where: { parentId: id }, transaction }))
    )
      throw AppError.conflict(
        "CATEGORY_HAS_CHILDREN",
        "Move or archive child categories first.",
      );
    // Publication requires a primary category; do not strand live products.
    if (
      kind === "categories" &&
      (await Product.count({
        where: {
          categoryId: id,
          status: { [Op.in]: ["published", "scheduled"] },
        },
        transaction,
      }))
    )
      throw AppError.conflict(
        "CATEGORY_IN_USE",
        "Move published or scheduled products to another category first.",
      );
    row.active = false;
    row.version += 1;
    await row.save({ transaction });
    await row.destroy({ transaction });
    await recordAudit({
      actorId,
      action: `catalog.${kind}.archive`,
      resourceType: kind.slice(0, -1),
      resourceId: id,
      before: dto(row, kind),
      request,
      transaction,
    });
  });
}

export async function restoreTaxonomy(
  kind: RuntimeValue,
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const value: RuntimeValue = definition(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await value.model.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row || !row.deletedAt)
      throw AppError.notFound("Archived taxonomy record not found.");
    await row.restore({ transaction });
    row.version += 1;
    await row.save({ transaction });
    await recordAudit({
      actorId,
      action: `catalog.${kind}.restore`,
      resourceType: kind.slice(0, -1),
      resourceId: id,
      after: dto(row, kind),
      request,
      transaction,
    });
    return getTaxonomyWithinTransaction(kind, id, transaction);
  });
}

export async function reorderTaxonomies(
  kind: RuntimeValue,
  items: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const value: RuntimeValue = definition(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const ids: RuntimeValue = items.map((item: RuntimeValue) => item.id);
    const rows: RuntimeValue = await value.model.findAll({
      where: { id: { [Op.in]: ids } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (rows.length !== new Set(ids).size)
      throw AppError.unprocessable(
        "INVALID_REORDER",
        "One or more records do not exist.",
      );
    const byId = new Map(rows.map((row: RuntimeValue) => [row.id, row]));
    for (const item of items) {
      const row: RuntimeValue = byId.get(item.id);
      if (Number(item.version) !== Number(row.version))
        throw AppError.conflict(
          "VERSION_CONFLICT",
          "A reordered record changed. Refresh and try again.",
        );
      row.displayOrder = item.displayOrder;
      row.version += 1;
      await row.save({ transaction });
    }
    await recordAudit({
      actorId,
      action: `catalog.${kind}.reorder`,
      resourceType: kind,
      metadata: { ids },
      request,
      transaction,
    });
  });
}

function attributeDto(attribute: RuntimeValue) {
  return {
    id: attribute.id,
    key: attribute.key,
    type: attribute.type,
    filterable: attribute.filterable,
    variationCapable: attribute.variationCapable,
    displayOrder: attribute.displayOrder,
    active: attribute.active,
    version: attribute.version,
    archivedAt: attribute.deletedAt || null,
    translations: Object.fromEntries(
      (attribute.translations || []).map((row: RuntimeValue) => [
        row.locale,
        { label: row.label },
      ]),
    ),
    values: (attribute.values || []).map((value: RuntimeValue) => ({
      id: value.id,
      slug: value.slug,
      value: value.value,
      colorHex: value.colorHex,
      displayOrder: value.displayOrder,
      active: value.active,
      version: value.version,
      archivedAt: value.deletedAt || null,
      translations: Object.fromEntries(
        (value.translations || []).map((row: RuntimeValue) => [
          row.locale,
          { label: row.label },
        ]),
      ),
    })),
  };
}

const attributeInclude: RuntimeValue = [
  { model: AttributeTranslation, as: "translations" },
  {
    model: AttributeValue,
    as: "values",
    required: false,
    paranoid: false,
    include: [{ model: AttributeValueTranslation, as: "translations" }],
  },
];

export async function listAdminAttributes() {
  const rows: RuntimeValue = await Attribute.findAll({
    paranoid: false,
    include: attributeInclude,
    order: [
      ["displayOrder", "ASC"],
      [{ model: AttributeValue, as: "values" }, "displayOrder", "ASC"],
    ],
  });
  return rows.map(attributeDto);
}

export async function createAttribute(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const attribute: RuntimeValue = await Attribute.create(
      {
        id: newId(),
        key: payload.key,
        type: payload.type,
        filterable: payload.filterable,
        variationCapable: payload.variationCapable,
        displayOrder: payload.displayOrder,
        active: true,
        version: 1,
      },
      { transaction },
    );
    await AttributeTranslation.bulkCreate(
      ["en", "bn"].map((locale: RuntimeValue) => ({
        id: newId(),
        attributeId: attribute.id,
        locale,
        label: payload.translations[locale].label,
      })),
      { transaction },
    );
    for (const value of payload.values || []) {
      const created: RuntimeValue = await AttributeValue.create(
        {
          id: newId(),
          attributeId: attribute.id,
          slug: value.slug,
          value: value.value,
          colorHex: value.colorHex || null,
          displayOrder: value.displayOrder,
          active: true,
          version: 1,
        },
        { transaction },
      );
      await AttributeValueTranslation.bulkCreate(
        ["en", "bn"].map((locale: RuntimeValue) => ({
          id: newId(),
          valueId: created.id,
          locale,
          label: value.translations[locale].label,
        })),
        { transaction },
      );
    }
    await recordAudit({
      actorId,
      action: "catalog.attribute.create",
      resourceType: "attribute",
      resourceId: attribute.id,
      after: payload,
      request,
      transaction,
    });
    const hydrated: RuntimeValue = await Attribute.findByPk(attribute.id, {
      include: attributeInclude,
      transaction,
    });
    return attributeDto(hydrated);
  });
}

export async function attributeUsage(id: RuntimeValue) {
  const attribute: RuntimeValue = await Attribute.findByPk(id, {
    paranoid: false,
  });
  if (!attribute) throw AppError.notFound("Attribute not found.");
  const [products, variants]: RuntimeValue = await Promise.all([
    ProductAttribute.count({ where: { attributeId: id } }),
    ProductVariant.count({
      include: [
        {
          model: AttributeValue,
          as: "attributeValues",
          where: { attributeId: id },
          through: { attributes: [] },
          required: true,
        },
      ],
    }),
  ]);
  return { products, variants };
}

async function lockAttribute(id: RuntimeValue, transaction: RuntimeValue) {
  const attribute: RuntimeValue = await Attribute.findByPk(id, {
    paranoid: false,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!attribute) throw AppError.notFound("Attribute not found.");
  return attribute;
}

async function hydratedAttribute(id: RuntimeValue, transaction: RuntimeValue) {
  return attributeDto(
    await Attribute.findByPk(id, {
      paranoid: false,
      include: attributeInclude,
      transaction,
    }),
  );
}

async function saveLabels(
  model: RuntimeValue,
  foreignKey: string,
  ownerId: string,
  translations: RuntimeValue,
  transaction: RuntimeValue,
) {
  for (const locale of ["en", "bn"]) {
    const [row]: RuntimeValue = await model.findOrCreate({
      where: { [foreignKey]: ownerId, locale },
      defaults: {
        id: newId(),
        [foreignKey]: ownerId,
        locale,
        label: translations[locale].label,
      },
      transaction,
    });
    if (!row.isNewRecord)
      await row.update({ label: translations[locale].label }, { transaction });
  }
}

export async function updateAttribute(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const attribute: RuntimeValue = await lockAttribute(id, transaction);
    if (Number(payload.version) !== Number(attribute.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This attribute changed. Refresh and review the latest version.",
      );
    const before: RuntimeValue = await hydratedAttribute(id, transaction);
    await attribute.update(
      {
        filterable: payload.filterable,
        variationCapable: payload.variationCapable,
        displayOrder: payload.displayOrder,
        active: payload.active,
        version: attribute.version + 1,
      },
      { transaction },
    );
    await saveLabels(
      AttributeTranslation,
      "attributeId",
      attribute.id,
      payload.translations,
      transaction,
    );
    const after: RuntimeValue = await hydratedAttribute(id, transaction);
    await recordAudit({
      actorId,
      action: "catalog.attribute.update",
      resourceType: "attribute",
      resourceId: id,
      before,
      after,
      request,
      transaction,
    });
    return after;
  });
}

export async function createAttributeValue(
  attributeId: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const attribute: RuntimeValue = await lockAttribute(
      attributeId,
      transaction,
    );
    if (
      await AttributeValue.count({
        where: { attributeId, slug: payload.slug },
        paranoid: false,
        transaction,
      })
    )
      throw new AppError(
        409,
        "VALUE_SLUG_IN_USE",
        "This attribute already has a value with that slug.",
        { slug: ["This slug is already used by another value."] },
      );
    const value: RuntimeValue = await AttributeValue.create(
      {
        id: newId(),
        attributeId: attribute.id,
        slug: payload.slug,
        value: payload.value,
        colorHex: payload.colorHex || null,
        displayOrder: payload.displayOrder,
        active: true,
        version: 1,
      },
      { transaction },
    );
    await saveLabels(
      AttributeValueTranslation,
      "valueId",
      value.id,
      payload.translations,
      transaction,
    );
    const after: RuntimeValue = await hydratedAttribute(
      attributeId,
      transaction,
    );
    await recordAudit({
      actorId,
      action: "catalog.attribute_value.create",
      resourceType: "attribute",
      resourceId: attributeId,
      metadata: { valueId: value.id, slug: payload.slug },
      request,
      transaction,
    });
    return after;
  });
}

export async function updateAttributeValue(
  attributeId: RuntimeValue,
  valueId: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    await lockAttribute(attributeId, transaction);
    const value: RuntimeValue = await AttributeValue.findOne({
      where: { id: valueId, attributeId },
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!value) throw AppError.notFound("Attribute value not found.");
    if (Number(payload.version) !== Number(value.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This value changed. Refresh and review the latest version.",
      );
    // The raw value is copied into variant attributes, so it is immutable.
    await value.update(
      {
        colorHex: payload.colorHex || null,
        displayOrder: payload.displayOrder,
        active: payload.active,
        version: value.version + 1,
      },
      { transaction },
    );
    await saveLabels(
      AttributeValueTranslation,
      "valueId",
      value.id,
      payload.translations,
      transaction,
    );
    await recordAudit({
      actorId,
      action: "catalog.attribute_value.update",
      resourceType: "attribute",
      resourceId: attributeId,
      metadata: { valueId, active: payload.active },
      request,
      transaction,
    });
    return hydratedAttribute(attributeId, transaction);
  });
}

function sizeChartDto(chart: RuntimeValue) {
  return {
    id: chart.id,
    name: chart.name,
    units: chart.units,
    titleEn: chart.titleEn,
    titleBn: chart.titleBn,
    rows: [...(chart.rows || [])]
      .sort(
        (left: RuntimeValue, right: RuntimeValue) =>
          Number(left.displayOrder) - Number(right.displayOrder),
      )
      .map((row: RuntimeValue) => ({
        labelEn: row.labelEn,
        labelBn: row.labelBn,
        cells: row.cells,
      })),
    version: Number(chart.version),
    archivedAt: chart.deletedAt || null,
    updatedAt: chart.updatedAt,
  };
}

export async function listSizeCharts(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const result: RuntimeValue = await SizeChart.findAndCountAll({
    where: query.search
      ? { name: { [Op.like]: likeContains(query.search, 80) } }
      : {},
    include: [{ model: SizeChartRow, as: "rows" }],
    distinct: true,
    limit,
    offset,
    order: [["name", "ASC"]],
  });
  return {
    data: result.rows.map(sizeChartDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function getSizeChart(id: RuntimeValue) {
  const chart: RuntimeValue = await SizeChart.findByPk(id, {
    include: [{ model: SizeChartRow, as: "rows" }],
  });
  if (!chart) throw AppError.notFound("Size chart not found.");
  return sizeChartDto(chart);
}

async function replaceChartRows(
  chartId: string,
  rows: RuntimeValue,
  transaction: RuntimeValue,
) {
  await SizeChartRow.destroy({ where: { chartId }, transaction });
  await SizeChartRow.bulkCreate(
    rows.map((row: RuntimeValue, index: number) => ({
      id: newId(),
      chartId,
      labelEn: row.labelEn,
      labelBn: row.labelBn,
      cells: row.cells,
      displayOrder: index,
    })),
    { transaction },
  );
}

export async function createSizeChart(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const chart: RuntimeValue = await SizeChart.create(
      {
        id: newId(),
        name: payload.name,
        units: payload.units,
        titleEn: payload.titleEn,
        titleBn: payload.titleBn,
        version: 1,
      },
      { transaction },
    );
    await replaceChartRows(chart.id, payload.rows, transaction);
    await recordAudit({
      actorId,
      action: "catalog.size_chart.create",
      resourceType: "size_chart",
      resourceId: chart.id,
      after: payload,
      request,
      transaction,
    });
    return sizeChartDto(
      await SizeChart.findByPk(chart.id, {
        include: [{ model: SizeChartRow, as: "rows" }],
        transaction,
      }),
    );
  });
}

export async function updateSizeChart(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const chart: RuntimeValue = await SizeChart.findByPk(id, {
      include: [{ model: SizeChartRow, as: "rows" }],
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: SizeChart },
    });
    if (!chart) throw AppError.notFound("Size chart not found.");
    if (Number(payload.version) !== Number(chart.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This size chart changed. Refresh and review the latest version.",
      );
    const before = sizeChartDto(chart);
    await chart.update(
      {
        name: payload.name,
        units: payload.units,
        titleEn: payload.titleEn,
        titleBn: payload.titleBn,
        version: chart.version + 1,
      },
      { transaction },
    );
    await replaceChartRows(chart.id, payload.rows, transaction);
    const after = sizeChartDto(
      await SizeChart.findByPk(id, {
        include: [{ model: SizeChartRow, as: "rows" }],
        transaction,
      }),
    );
    await recordAudit({
      actorId,
      action: "catalog.size_chart.update",
      resourceType: "size_chart",
      resourceId: id,
      before,
      after,
      request,
      transaction,
    });
    return after;
  });
}

export async function archiveSizeChart(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const chart: RuntimeValue = await SizeChart.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!chart) throw AppError.notFound("Size chart not found.");
    const live: RuntimeValue = await chart.countProducts({
      where: { status: { [Op.in]: ["published", "scheduled"] } },
      transaction,
    });
    if (live)
      throw AppError.conflict(
        "SIZE_CHART_IN_USE",
        "Published products use this size chart. Assign another chart first.",
      );
    chart.version += 1;
    await chart.save({ transaction });
    await chart.destroy({ transaction });
    await recordAudit({
      actorId,
      action: "catalog.size_chart.archive",
      resourceType: "size_chart",
      resourceId: id,
      request,
      transaction,
    });
  });
}
