import sanitizeHtml from "sanitize-html";
import { Op } from "sequelize";
import {
  Category,
  Collection,
  ContactMessage,
  ContentRevision,
  HomepageSection,
  MediaAsset,
  Menu,
  MenuItem,
  Page,
  PageTranslation,
  Post,
  PostCategory,
  PostTranslation,
  Product,
  ThemeSetting,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { sha256 } from "../../lib/crypto.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { dateRangeWhere } from "../../lib/date-range.js";
import { likeContains } from "../../lib/like.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { mediaPublicUrl } from "../media/media.storage.js";

const allowedBlocks = new Set([
  "rich_text",
  "image",
  "hero",
  "banner",
  "product_carousel",
  "category_grid",
  "collection_grid",
  "countdown",
  "testimonials",
  "faq",
  "newsletter",
  "blog_feed",
]);
const translatedInclude = (model: RuntimeValue) => ({
  model,
  as: "translations",
});

function validateUrl(value: RuntimeValue) {
  if (value == null || value === "") return value;
  // Site-relative paths only: "//host" and "/\\host" are protocol-relative
  // links to another origin.
  if (/^\/(?![/\\])/.test(String(value))) return String(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw AppError.unprocessable(
      "UNSAFE_CONTENT_URL",
      "Content contains an invalid URL.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw AppError.unprocessable(
      "UNSAFE_CONTENT_URL",
      "Content URLs must use HTTPS and contain no credentials.",
    );
  return url.toString();
}

export function sanitizeValue(
  value: RuntimeValue,
  key: RuntimeValue = "",
): RuntimeValue {
  if (Array.isArray(value))
    return value.map((item: RuntimeValue) => sanitizeValue(item, key));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /(?:url|link|href)$/i.test(key))
      return validateUrl(value);
    if (
      typeof value === "string" &&
      /(?:html|richText|content|body)$/i.test(key)
    )
      return sanitizeHtml(value, {
        allowedTags: [
          "p",
          "br",
          "strong",
          "em",
          "ul",
          "ol",
          "li",
          "h2",
          "h3",
          "blockquote",
          "a",
        ],
        allowedAttributes: { a: ["href", "title"] },
        allowedSchemes: ["https"],
      });
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]: RuntimeValue) => [
      childKey,
      // Localised wrappers ({ html: { en, bn } }) keep the field's type, so
      // the HTML/URL checks still apply to each locale's value.
      sanitizeValue(child, ["en", "bn"].includes(childKey) ? key : childKey),
    ]),
  );
}

function normalizeBlocks(blocks: RuntimeValue) {
  if (!Array.isArray(blocks) || blocks.length > 100)
    throw AppError.unprocessable(
      "INVALID_CONTENT_BLOCKS",
      "Content blocks must be an array of at most 100 items.",
    );
  return blocks.map((block: RuntimeValue, index: RuntimeValue) => {
    if (!block || typeof block !== "object" || !allowedBlocks.has(block.type))
      throw AppError.unprocessable(
        "INVALID_CONTENT_BLOCK",
        `Block ${index + 1} has an unsupported type.`,
      );
    return {
      id: typeof block.id === "string" ? block.id.slice(0, 80) : newId(),
      type: block.type,
      data: sanitizeValue(block.data || {}),
    };
  });
}

function translation(rows: RuntimeValue, locale: RuntimeValue) {
  return (
    rows?.find((row: RuntimeValue) => row.locale === locale) ||
    rows?.find((row: RuntimeValue) => row.locale === "en") ||
    rows?.[0]
  );
}
function publicContent(row: RuntimeValue, locale: RuntimeValue) {
  const value: RuntimeValue = translation(row.translations, locale);
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    title: value?.title || row.slug,
    excerpt: value?.excerpt || "",
    blocks: value?.blocks || [],
    seo: {
      title: value?.seoTitle || value?.title || row.slug,
      description: value?.seoDescription || value?.excerpt || "",
    },
    publishedAt: row.publishAt || row.updatedAt,
    updatedAt: row.updatedAt,
    coverUrl: row.coverMedia ? mediaPublicUrl(row.coverMedia.storageKey) : null,
  };
}
function adminContent(row: RuntimeValue) {
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    template: row.template,
    categoryId: row.categoryId || null,
    authorId: row.authorId || null,
    coverMediaId: row.coverMediaId || null,
    status: row.status,
    publishAt: row.publishAt,
    version: Number(row.version),
    translations: Object.fromEntries(
      ["en", "bn"].map((locale: RuntimeValue) => {
        const value: RuntimeValue = row.translations?.find(
          (item: RuntimeValue) => item.locale === locale,
        );
        return [
          locale,
          {
            title: value?.title || "",
            excerpt: value?.excerpt || "",
            blocks: value?.blocks || [],
            seoTitle: value?.seoTitle || "",
            seoDescription: value?.seoDescription || "",
          },
        ];
      }),
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPublicPage(slug: RuntimeValue, locale: RuntimeValue) {
  const row: RuntimeValue = await Page.findOne({
    where: { slug, status: "published" },
    include: [translatedInclude(PageTranslation)],
  });
  if (!row) throw AppError.notFound("Page not found.");
  return publicContent(row, locale);
}
export async function listPublicPosts(
  query: RuntimeValue,
  locale: RuntimeValue,
) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {
    status: "published",
    ...(query.type ? { type: query.type } : {}),
  };
  const result: RuntimeValue = await Post.findAndCountAll({
    where,
    include: [
      translatedInclude(PostTranslation),
      { model: PostCategory, as: "category", required: false },
      {
        model: MediaAsset,
        as: "coverMedia",
        required: false,
        where: { status: "ready", privacy: "public" },
      },
    ],
    distinct: true,
    limit,
    offset,
    order: [
      ["publishAt", "DESC"],
      ["createdAt", "DESC"],
    ],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => ({
      ...publicContent(row, locale),
      category: row.category
        ? {
            slug: row.category.slug,
            name: locale === "bn" ? row.category.nameBn : row.category.nameEn,
          }
        : null,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}
export async function getPublicPost(slug: RuntimeValue, locale: RuntimeValue) {
  const row: RuntimeValue = await Post.findOne({
    where: { slug, status: "published" },
    include: [
      translatedInclude(PostTranslation),
      { model: PostCategory, as: "category", required: false },
      {
        model: MediaAsset,
        as: "coverMedia",
        required: false,
        where: { status: "ready", privacy: "public" },
      },
    ],
  });
  if (!row) throw AppError.notFound("Post not found.");
  return {
    ...publicContent(row, locale),
    category: row.category
      ? {
          slug: row.category.slug,
          name: locale === "bn" ? row.category.nameBn : row.category.nameEn,
        }
      : null,
  };
}

export async function storefrontNavigation(locale: RuntimeValue) {
  const rows: RuntimeValue = await Menu.findAll({
    where: { status: "published" },
    include: [
      {
        model: MenuItem,
        as: "items",
        where: { visible: true },
        required: false,
      },
    ],
    order: [[{ model: MenuItem, as: "items" }, "displayOrder", "ASC"]],
  });
  const targets: RuntimeValue = await navigationTargets(
    rows.flatMap((menu: RuntimeValue) => menu.items),
  );
  return Object.fromEntries(
    rows.map((menu: RuntimeValue) => [
      menu.location,
      {
        id: menu.id,
        name: menu.name,
        items: menu.items
          .filter((item: RuntimeValue) => !item.parentId)
          .map((item: RuntimeValue) =>
            menuItemDto(item, locale, menu.items, targets),
          ),
      },
    ]),
  );
}
async function navigationTargets(items: RuntimeValue) {
  const groups: RuntimeValue = items
    .filter((item: RuntimeValue) => item.targetId)
    .reduce((result: RuntimeValue, item: RuntimeValue) => {
      (result[item.targetType] ||= []).push(item);
      return result;
    }, {});
  const definitions: RuntimeValue = {
    product: [Product, "product"],
    category: [Category, "category"],
    collection: [Collection, "collection"],
    page: [Page, "page"],
  };
  const maps: RuntimeValue = await Promise.all(
    Object.entries(definitions).map(
      async ([type, [Model, prefix]]: RuntimeValue) => {
        const ids: RuntimeValue = [
          ...new Set(
            (groups[type] || []).map((item: RuntimeValue) => item.targetId),
          ),
        ];
        const records: RuntimeValue = ids.length
          ? await Model.findAll({
              where: { id: { [Op.in]: ids } },
              attributes: ["id", "slug"],
            })
          : [];
        return records.map((row: RuntimeValue) => [
          `${type}:${row.id}`,
          `/${prefix}/${row.slug}`,
        ]);
      },
    ),
  );
  return new Map(maps.flat());
}
function menuItemDto(
  item: RuntimeValue,
  locale: RuntimeValue,
  all: RuntimeValue,
  targets: RuntimeValue,
) {
  const path: RuntimeValue =
    item.targetType === "url"
      ? validateUrl(item.url)
      : targets.get(`${item.targetType}:${item.targetId}`) || null;
  return {
    id: item.id,
    label: locale === "bn" ? item.labelBn : item.labelEn,
    targetType: item.targetType,
    targetId: item.targetId,
    url: path,
    children: all
      .filter(
        (child: RuntimeValue) => child.parentId === item.id && child.visible,
      )
      .sort(
        (a: RuntimeValue, b: RuntimeValue) => a.displayOrder - b.displayOrder,
      )
      .map((child: RuntimeValue) => menuItemDto(child, locale, all, targets)),
  };
}

export async function storefrontHome(locale: RuntimeValue) {
  const now = new Date();
  const [sections, theme]: RuntimeValue = await Promise.all([
    HomepageSection.findAll({
      where: {
        status: "published",
        enabled: true,
        [Op.and]: [
          { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
          { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: now } }] },
        ],
      },
      order: [["displayOrder", "ASC"]],
    }),
    ThemeSetting.findOne({
      where: { status: "published" },
      order: [["publishedAt", "DESC"]],
    }),
  ]);
  return {
    locale,
    sections: sections.map((row: RuntimeValue) => ({
      id: row.id,
      type: row.type,
      config: row.config,
      displayOrder: row.displayOrder,
    })),
    theme: theme?.settings || null,
  };
}
export async function sitemapData() {
  const [pages, posts, products, categories, collections]: RuntimeValue =
    await Promise.all([
      Page.findAll({
        where: { status: "published" },
        attributes: ["slug", "updatedAt"],
      }),
      Post.findAll({
        where: { status: "published" },
        attributes: ["slug", "type", "updatedAt"],
      }),
      Product.findAll({
        where: {
          status: "published",
          visibility: { [Op.in]: ["catalog_search", "catalog"] },
        },
        attributes: ["slug", "updatedAt"],
      }),
      Category.findAll({ attributes: ["slug", "updatedAt"] }),
      Collection.findAll({ attributes: ["slug", "updatedAt"] }),
    ]);
  return { pages, posts, products, categories, collections };
}

export async function submitContact(
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  const phone: RuntimeValue = payload.phone
    ? normalizePhone(payload.phone)
    : null;
  const email: RuntimeValue = payload.email
    ? normalizeEmail(payload.email)
    : null;
  if (payload.phone && !phone)
    throw AppError.unprocessable(
      "INVALID_PHONE",
      "Enter a valid Bangladeshi phone number.",
    );
  if (!phone && !email)
    throw AppError.unprocessable(
      "CONTACT_REQUIRED",
      "Enter a phone number or email address.",
    );
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await ContactMessage.create(
      {
        id: newId(),
        name: sanitizeHtml(payload.name, { allowedTags: [] }),
        phone,
        email,
        subject: sanitizeHtml(payload.subject, { allowedTags: [] }),
        message: sanitizeHtml(payload.message, { allowedTags: [] }),
        status: "new",
        ipHash: sha256(String(request.ip || "unknown")),
      },
      { transaction },
    );
    await notifyStaff("support", {
      event: "contact.received",
      title: `New message from ${row.name}`,
      message: row.subject,
      link: "/admin/contact-messages",
      data: { contactMessageId: row.id },
      transaction,
    });
    return { id: row.id, accepted: true };
  });
}

function contentModels(kind: RuntimeValue) {
  return kind === "page"
    ? { Model: Page, Translation: PageTranslation, foreignKey: "pageId" }
    : { Model: Post, Translation: PostTranslation, foreignKey: "postId" };
}
export async function listAdminContent(
  kind: RuntimeValue,
  query: RuntimeValue,
) {
  const { Model, Translation }: RuntimeValue = contentModels(kind);
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {
    ...(query.status ? { status: query.status } : {}),
    ...dateRangeWhere(query),
  };
  if (query.search) where.slug = { [Op.like]: likeContains(query.search, 100) };
  const result: RuntimeValue = await Model.findAndCountAll({
    where,
    paranoid: false,
    include: [translatedInclude(Translation)],
    distinct: true,
    limit,
    offset,
    order: [["updatedAt", "DESC"]],
  });
  return {
    data: result.rows.map(adminContent),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}
export async function getAdminContent(kind: RuntimeValue, id: RuntimeValue) {
  const { Model, Translation }: RuntimeValue = contentModels(kind);
  const row: RuntimeValue = await Model.findByPk(id, {
    paranoid: false,
    include: [translatedInclude(Translation)],
  });
  if (!row) throw AppError.notFound(`${kind} not found.`);
  return adminContent(row);
}

async function writeRevision(
  kind: RuntimeValue,
  row: RuntimeValue,
  actorId: RuntimeValue,
  summary: RuntimeValue,
  transaction: RuntimeValue,
) {
  const current: RuntimeValue = await getAdminContentTransactional(
    kind,
    row.id,
    transaction,
  );
  await ContentRevision.create(
    {
      id: newId(),
      entityType: kind,
      entityId: row.id,
      version: Number(row.version),
      payload: current,
      actorId,
      changeSummary: summary || null,
      publishedAt: row.status === "published" ? new Date() : null,
    },
    { transaction },
  );
}
async function getAdminContentTransactional(
  kind: RuntimeValue,
  id: RuntimeValue,
  transaction: RuntimeValue,
) {
  const { Model, Translation }: RuntimeValue = contentModels(kind);
  return adminContent(
    await Model.findByPk(id, {
      paranoid: false,
      include: [translatedInclude(Translation)],
      transaction,
    }),
  );
}

export async function saveContent(
  kind: RuntimeValue,
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const { Model, Translation, foreignKey }: RuntimeValue = contentModels(kind);
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = id
      ? await Model.findByPk(id, {
          paranoid: false,
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    if (id && !row) throw AppError.notFound(`${kind} not found.`);
    if (row?.deletedAt)
      throw AppError.conflict(
        "RESOURCE_ARCHIVED",
        `Restore this ${kind} before editing it.`,
      );
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        `This ${kind} changed. Refresh and review the latest version.`,
      );
    if (payload.status === "scheduled" && !payload.publishAt)
      throw AppError.unprocessable(
        "PUBLISH_AT_REQUIRED",
        "Choose when scheduled content should be published.",
        { publishAt: ["Choose when scheduled content should be published."] },
      );
    const base =
      kind === "page"
        ? {
            slug: payload.slug,
            template: payload.template || "standard",
            status: payload.status || "draft",
            publishAt: payload.publishAt || null,
          }
        : {
            slug: payload.slug,
            type: payload.type || "blog",
            categoryId: payload.categoryId || null,
            authorId: actorId,
            coverMediaId: payload.coverMediaId || null,
            status: payload.status || "draft",
            publishAt: payload.publishAt || null,
          };
    if (!row)
      row = await Model.create(
        { id: newId(), ...base, version: 1 },
        { transaction },
      );
    else {
      await row.update({ ...base, version: row.version + 1 }, { transaction });
      await Translation.destroy({
        where: { [foreignKey]: row.id },
        transaction,
      });
    }
    await Translation.bulkCreate(
      ["en", "bn"].map((locale: RuntimeValue) => ({
        id: newId(),
        [foreignKey]: row.id,
        locale,
        title: payload.translations[locale].title,
        excerpt: payload.translations[locale].excerpt || null,
        blocks: normalizeBlocks(payload.translations[locale].blocks),
        seoTitle: payload.translations[locale].seoTitle || null,
        seoDescription: payload.translations[locale].seoDescription || null,
      })),
      { transaction },
    );
    await writeRevision(kind, row, actorId, payload.changeSummary, transaction);
    await recordAudit({
      actorId,
      action: `cms.${kind}_${id ? "update" : "create"}`,
      resourceType: kind,
      resourceId: row.id,
      after: { slug: row.slug, status: row.status, version: row.version },
      request,
      transaction,
    });
    if (row.status === "published")
      await addDomainEvent({
        topic: `content.${kind}.published`,
        aggregateType: kind,
        aggregateId: row.id,
        payload: { id: row.id, slug: row.slug },
        transaction,
      });
    return getAdminContentTransactional(kind, row.id, transaction);
  });
}

export async function listRevisions(kind: RuntimeValue, id: RuntimeValue) {
  const rows: RuntimeValue = await ContentRevision.findAll({
    where: { entityType: kind, entityId: id },
    order: [["version", "DESC"]],
    limit: 100,
  });
  return rows.map((row: RuntimeValue) => ({
    id: row.id,
    version: row.version,
    changeSummary: row.changeSummary,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  }));
}
export async function rollbackContent(
  kind: RuntimeValue,
  id: RuntimeValue,
  revisionId: RuntimeValue,
  expectedVersion: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  const revision: RuntimeValue = await ContentRevision.findOne({
    where: { id: revisionId, entityType: kind, entityId: id },
  });
  if (!revision) throw AppError.notFound("Revision not found.");
  return saveContent(
    kind,
    id,
    {
      ...revision.payload,
      status: "draft",
      version: expectedVersion,
      changeSummary: `Rolled back from revision ${revision.version}`,
    },
    actorId,
    request,
  );
}

export async function listHomeAdmin() {
  const rows: RuntimeValue = await HomepageSection.findAll({
    paranoid: false,
    order: [["displayOrder", "ASC"]],
  });
  return rows.map((row: RuntimeValue) => ({
    id: row.id,
    type: row.type,
    enabled: row.enabled,
    displayOrder: row.displayOrder,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    config: row.config,
    status: row.status,
    version: Number(row.version),
    archivedAt: row.deletedAt || null,
  }));
}
export async function saveHomeSection(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = id
      ? await HomepageSection.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    if (id && !row) throw AppError.notFound("Homepage section not found.");
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This homepage section changed.",
      );
    const values: RuntimeValue = {
      type: payload.type,
      enabled: payload.enabled,
      displayOrder: payload.displayOrder,
      startsAt: payload.startsAt || null,
      endsAt: payload.endsAt || null,
      config: sanitizeValue(payload.config),
      status: payload.status,
    };
    if (!row)
      row = await HomepageSection.create(
        { id: newId(), ...values, version: 1 },
        { transaction },
      );
    else
      await row.update(
        { ...values, version: row.version + 1 },
        { transaction },
      );
    await recordAudit({
      actorId,
      action: "cms.home_section_save",
      resourceType: "homepage_section",
      resourceId: row.id,
      request,
      transaction,
    });
    return { ...values, id: row.id, version: Number(row.version) };
  });
}

function menuAdminDto(row: RuntimeValue) {
  return {
    id: row.id,
    location: row.location,
    name: row.name,
    status: row.status,
    version: Number(row.version),
    items: (row.items || [])
      .sort(
        (a: RuntimeValue, b: RuntimeValue) => a.displayOrder - b.displayOrder,
      )
      .map((item: RuntimeValue) => ({
        id: item.id,
        parentId: item.parentId,
        targetType: item.targetType,
        targetId: item.targetId,
        url: item.url,
        labelEn: item.labelEn,
        labelBn: item.labelBn,
        displayOrder: item.displayOrder,
        visible: item.visible,
      })),
  };
}
export async function listMenusAdmin() {
  const rows: RuntimeValue = await Menu.findAll({
    include: [{ model: MenuItem, as: "items", required: false }],
    order: [["location", "ASC"]],
  });
  return rows.map(menuAdminDto);
}
export async function saveMenu(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    let row: RuntimeValue = id
      ? await Menu.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    if (id && !row) throw AppError.notFound("Menu not found.");
    if (row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This menu changed. Refresh and review it.",
      );
    const before = row
      ? {
          location: row.location,
          name: row.name,
          status: row.status,
          version: Number(row.version),
        }
      : null;
    if (!row)
      row = await Menu.create(
        {
          id: newId(),
          location: payload.location,
          name: payload.name,
          status: payload.status,
          version: 1,
        },
        { transaction },
      );
    else
      await row.update(
        {
          location: payload.location,
          name: payload.name,
          status: payload.status,
          version: row.version + 1,
        },
        { transaction },
      );
    await MenuItem.destroy({ where: { menuId: row.id }, transaction });
    const ids = new Map(
      payload.items.map((item: RuntimeValue) => [item.clientKey, newId()]),
    );
    for (const [index, item] of payload.items.entries()) {
      if (item.parentKey && !ids.has(item.parentKey))
        throw AppError.unprocessable(
          "INVALID_MENU_PARENT",
          `Menu item ${index + 1} has an unknown parent.`,
        );
      await MenuItem.create(
        {
          id: ids.get(item.clientKey),
          menuId: row.id,
          parentId: item.parentKey ? ids.get(item.parentKey) : null,
          targetType: item.targetType,
          targetId: item.targetType === "url" ? null : item.targetId,
          url: item.targetType === "url" ? validateUrl(item.url) : null,
          labelEn: item.labelEn,
          labelBn: item.labelBn,
          displayOrder: item.displayOrder,
          visible: item.visible,
        },
        { transaction },
      );
    }
    await recordAudit({
      actorId,
      action: "cms.menu_save",
      resourceType: "menu",
      resourceId: row.id,
      before,
      after: {
        location: row.location,
        name: row.name,
        status: row.status,
        version: Number(row.version),
        itemCount: payload.items.length,
      },
      request,
      transaction,
    });
    return menuAdminDto(
      await Menu.findByPk(row.id, {
        include: [{ model: MenuItem, as: "items" }],
        transaction,
      }),
    );
  });
}

export async function getThemeAdmin() {
  const rows: RuntimeValue = await ThemeSetting.findAll({
    order: [
      ["status", "ASC"],
      ["updatedAt", "DESC"],
    ],
  });
  return rows.map((row: RuntimeValue) => ({
    id: row.id,
    status: row.status,
    settings: row.settings,
    version: Number(row.version),
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  }));
}
export async function saveTheme(
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const source: RuntimeValue = payload.sourceId
      ? await ThemeSetting.findByPk(payload.sourceId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    if (payload.sourceId && !source)
      throw AppError.notFound("Source theme settings not found.");
    if (source && Number(payload.version) !== Number(source.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "Theme settings changed. Refresh and review the latest version.",
      );
    let row: RuntimeValue = await ThemeSetting.findOne({
      where: { status: payload.status },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!source && row && Number(payload.version) !== Number(row.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "Theme settings changed. Refresh and review the latest version.",
      );
    const settings: RuntimeValue = sanitizeValue(payload.settings);
    const before = row
      ? {
          id: row.id,
          status: row.status,
          settings: row.settings,
          version: Number(row.version),
        }
      : null;
    if (!row)
      row = await ThemeSetting.create(
        {
          id: newId(),
          status: payload.status,
          settings,
          version: 1,
          publishedAt: payload.status === "published" ? new Date() : null,
        },
        { transaction },
      );
    else
      await row.update(
        {
          settings,
          version: row.version + 1,
          publishedAt:
            payload.status === "published" ? new Date() : row.publishedAt,
        },
        { transaction },
      );
    await recordAudit({
      actorId,
      action:
        payload.status === "published" ? "cms.theme_publish" : "cms.theme_save",
      resourceType: "theme",
      resourceId: row.id,
      before,
      after: {
        id: row.id,
        status: row.status,
        settings: row.settings,
        version: Number(row.version),
      },
      request,
      transaction,
    });
    return {
      id: row.id,
      status: row.status,
      settings: row.settings,
      version: Number(row.version),
      publishedAt: row.publishedAt,
    };
  });
}
