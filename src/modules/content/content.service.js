import sanitizeHtml from 'sanitize-html';
import { Op } from 'sequelize';
import { Category, Collection, ContactMessage, ContentRevision, HomepageSection, Menu, MenuItem, Page, PageTranslation, Post, PostCategory, PostTranslation, Product, ThemeSetting } from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { sha256 } from '../../lib/crypto.js';
import { normalizeEmail, normalizePhone } from '../../lib/normalization.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { recordAudit } from '../audits/audit.service.js';
import { addDomainEvent, queueNotification } from '../events/outbox.service.js';

const allowedBlocks = new Set(['rich_text', 'image', 'hero', 'banner', 'product_carousel', 'category_grid', 'collection_grid', 'countdown', 'testimonials', 'faq', 'newsletter', 'blog_feed']);
const translatedInclude = (model) => ({ model, as: 'translations' });

function validateUrl(value) {
  if (value == null || value === '') return value;
  if (String(value).startsWith('/')) return String(value);
  let url;
  try { url = new URL(value); } catch { throw AppError.unprocessable('UNSAFE_CONTENT_URL', 'Content contains an invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw AppError.unprocessable('UNSAFE_CONTENT_URL', 'Content URLs must use HTTPS and contain no credentials.');
  return url.toString();
}

function sanitizeValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(?:url|link|href)$/i.test(key)) return validateUrl(value);
    if (typeof value === 'string' && /(?:html|richText|content)$/i.test(key)) return sanitizeHtml(value, { allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a'], allowedAttributes: { a: ['href', 'title'] }, allowedSchemes: ['https'] });
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)]));
}

export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 100) throw AppError.unprocessable('INVALID_CONTENT_BLOCKS', 'Content blocks must be an array of at most 100 items.');
  return blocks.map((block, index) => {
    if (!block || typeof block !== 'object' || !allowedBlocks.has(block.type)) throw AppError.unprocessable('INVALID_CONTENT_BLOCK', `Block ${index + 1} has an unsupported type.`);
    return { id: typeof block.id === 'string' ? block.id.slice(0, 80) : newId(), type: block.type, data: sanitizeValue(block.data || {}) };
  });
}

function translation(rows, locale) { return rows?.find((row) => row.locale === locale) || rows?.find((row) => row.locale === 'en') || rows?.[0]; }
function publicContent(row, locale) { const value = translation(row.translations, locale); return { id: row.id, slug: row.slug, type: row.type, title: value?.title || row.slug, excerpt: value?.excerpt || '', blocks: value?.blocks || [], seo: { title: value?.seoTitle || value?.title || row.slug, description: value?.seoDescription || value?.excerpt || '' }, publishedAt: row.publishAt || row.updatedAt, updatedAt: row.updatedAt }; }
function adminContent(row) { return { id: row.id, slug: row.slug, type: row.type, template: row.template, categoryId: row.categoryId || null, authorId: row.authorId || null, coverMediaId: row.coverMediaId || null, status: row.status, publishAt: row.publishAt, version: Number(row.version), translations: Object.fromEntries(['en', 'bn'].map((locale) => { const value = row.translations?.find((item) => item.locale === locale); return [locale, { title: value?.title || '', excerpt: value?.excerpt || '', blocks: value?.blocks || [], seoTitle: value?.seoTitle || '', seoDescription: value?.seoDescription || '' }]; })), createdAt: row.createdAt, updatedAt: row.updatedAt }; }

export async function getPublicPage(slug, locale) { const row = await Page.findOne({ where: { slug, status: 'published' }, include: [translatedInclude(PageTranslation)] }); if (!row) throw AppError.notFound('Page not found.'); return publicContent(row, locale); }
export async function listPublicPosts(query, locale) { const { page, pageSize, limit, offset } = pagination(query); const where = { status: 'published', ...(query.type ? { type: query.type } : {}) }; const result = await Post.findAndCountAll({ where, include: [translatedInclude(PostTranslation), { model: PostCategory, as: 'category', required: false }], distinct: true, limit, offset, order: [['publishAt', 'DESC'], ['createdAt', 'DESC']] }); return { data: result.rows.map((row) => ({ ...publicContent(row, locale), category: row.category ? { slug: row.category.slug, name: locale === 'bn' ? row.category.nameBn : row.category.nameEn } : null })), meta: pageEnvelope(result, page, pageSize).meta }; }
export async function getPublicPost(slug, locale) { const row = await Post.findOne({ where: { slug, status: 'published' }, include: [translatedInclude(PostTranslation), { model: PostCategory, as: 'category', required: false }] }); if (!row) throw AppError.notFound('Post not found.'); return { ...publicContent(row, locale), category: row.category ? { slug: row.category.slug, name: locale === 'bn' ? row.category.nameBn : row.category.nameEn } : null }; }

export async function storefrontNavigation(locale) {
  const rows = await Menu.findAll({ where: { status: 'published' }, include: [{ model: MenuItem, as: 'items', where: { visible: true }, required: false }], order: [[{ model: MenuItem, as: 'items' }, 'displayOrder', 'ASC']] });
  const targets = await navigationTargets(rows.flatMap((menu) => menu.items));
  return Object.fromEntries(rows.map((menu) => [menu.location, { id: menu.id, name: menu.name, items: menu.items.filter((item) => !item.parentId).map((item) => menuItemDto(item, locale, menu.items, targets)) }]));
}
async function navigationTargets(items) {
  const groups = items.filter((item) => item.targetId).reduce((result, item) => { (result[item.targetType] ||= []).push(item); return result; }, {});
  const definitions = { product: [Product, 'product'], category: [Category, 'category'], collection: [Collection, 'collection'], page: [Page, 'page'] };
  const maps = await Promise.all(Object.entries(definitions).map(async ([type, [Model, prefix]]) => {
    const ids = [...new Set((groups[type] || []).map((item) => item.targetId))];
    const records = ids.length ? await Model.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'slug'] }) : [];
    return records.map((row) => [`${type}:${row.id}`, `/${prefix}/${row.slug}`]);
  }));
  return new Map(maps.flat());
}
function menuItemDto(item, locale, all, targets) { const path = item.targetType === 'url' ? validateUrl(item.url) : targets.get(`${item.targetType}:${item.targetId}`) || null; return { id: item.id, label: locale === 'bn' ? item.labelBn : item.labelEn, targetType: item.targetType, targetId: item.targetId, url: path, children: all.filter((child) => child.parentId === item.id && child.visible).sort((a, b) => a.displayOrder - b.displayOrder).map((child) => menuItemDto(child, locale, all, targets)) }; }

export async function storefrontHome(locale) { const now = new Date(); const [sections, theme] = await Promise.all([HomepageSection.findAll({ where: { status: 'published', enabled: true, [Op.and]: [{ [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] }, { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: now } }] }] }, order: [['displayOrder', 'ASC']] }), ThemeSetting.findOne({ where: { status: 'published' }, order: [['publishedAt', 'DESC']] })]); return { locale, sections: sections.map((row) => ({ id: row.id, type: row.type, config: row.config, displayOrder: row.displayOrder })), theme: theme?.settings || null }; }
export async function sitemapData() { const [pages, posts, products, categories, collections] = await Promise.all([Page.findAll({ where: { status: 'published' }, attributes: ['slug', 'updatedAt'] }), Post.findAll({ where: { status: 'published' }, attributes: ['slug', 'type', 'updatedAt'] }), Product.findAll({ where: { status: 'published', visibility: { [Op.in]: ['catalog_search', 'catalog'] } }, attributes: ['slug', 'updatedAt'] }), Category.findAll({ attributes: ['slug', 'updatedAt'] }), Collection.findAll({ attributes: ['slug', 'updatedAt'] })]); return { pages, posts, products, categories, collections }; }

export async function submitContact(payload, request) {
  const phone = payload.phone ? normalizePhone(payload.phone) : null;
  const email = payload.email ? normalizeEmail(payload.email) : null;
  if (payload.phone && !phone) throw AppError.unprocessable('INVALID_PHONE', 'Enter a valid Bangladeshi phone number.');
  if (!phone && !email) throw AppError.unprocessable('CONTACT_REQUIRED', 'Enter a phone number or email address.');
  return sequelize.transaction(async (transaction) => {
    const row = await ContactMessage.create({ id: newId(), name: sanitizeHtml(payload.name, { allowedTags: [] }), phone, email, subject: sanitizeHtml(payload.subject, { allowedTags: [] }), message: sanitizeHtml(payload.message, { allowedTags: [] }), status: 'new', ipHash: sha256(String(request.ip || 'unknown')) }, { transaction });
    await queueNotification({ event: 'contact.received', channel: 'dashboard', recipient: 'staff:support', payload: { message: `New contact message: ${row.subject}`, contactMessageId: row.id }, transaction });
    return { id: row.id, accepted: true };
  });
}

function contentModels(kind) { return kind === 'page' ? { Model: Page, Translation: PageTranslation, foreignKey: 'pageId' } : { Model: Post, Translation: PostTranslation, foreignKey: 'postId' }; }
export async function listAdminContent(kind, query) { const { Model, Translation } = contentModels(kind); const { page, pageSize, limit, offset } = pagination(query); const where = query.status ? { status: query.status } : {}; if (query.search) where.slug = { [Op.like]: `%${String(query.search).slice(0, 100)}%` }; const result = await Model.findAndCountAll({ where, paranoid: false, include: [translatedInclude(Translation)], distinct: true, limit, offset, order: [['updatedAt', 'DESC']] }); return { data: result.rows.map(adminContent), meta: pageEnvelope(result, page, pageSize).meta }; }
export async function getAdminContent(kind, id) { const { Model, Translation } = contentModels(kind); const row = await Model.findByPk(id, { paranoid: false, include: [translatedInclude(Translation)] }); if (!row) throw AppError.notFound(`${kind} not found.`); return adminContent(row); }

async function writeRevision(kind, row, actorId, summary, transaction) { const current = await getAdminContentTransactional(kind, row.id, transaction); await ContentRevision.create({ id: newId(), entityType: kind, entityId: row.id, version: Number(row.version), payload: current, actorId, changeSummary: summary || null, publishedAt: row.status === 'published' ? new Date() : null }, { transaction }); }
async function getAdminContentTransactional(kind, id, transaction) { const { Model, Translation } = contentModels(kind); return adminContent(await Model.findByPk(id, { paranoid: false, include: [translatedInclude(Translation)], transaction })); }

export async function saveContent(kind, id, payload, actorId, request) {
  const { Model, Translation, foreignKey } = contentModels(kind);
  return sequelize.transaction(async (transaction) => {
    let row = id ? await Model.findByPk(id, { paranoid: false, transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (id && !row) throw AppError.notFound(`${kind} not found.`);
    if (row?.deletedAt) throw AppError.conflict('RESOURCE_ARCHIVED', `Restore this ${kind} before editing it.`);
    if (row && Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', `This ${kind} changed. Refresh and review the latest version.`);
    const base = kind === 'page' ? { slug: payload.slug, template: payload.template || 'standard', status: payload.status || 'draft', publishAt: payload.publishAt || null } : { slug: payload.slug, type: payload.type || 'blog', categoryId: payload.categoryId || null, authorId: actorId, coverMediaId: payload.coverMediaId || null, status: payload.status || 'draft', publishAt: payload.publishAt || null };
    if (!row) row = await Model.create({ id: newId(), ...base, version: 1 }, { transaction }); else { await row.update({ ...base, version: row.version + 1 }, { transaction }); await Translation.destroy({ where: { [foreignKey]: row.id }, transaction }); }
    await Translation.bulkCreate(['en', 'bn'].map((locale) => ({ id: newId(), [foreignKey]: row.id, locale, title: payload.translations[locale].title, excerpt: payload.translations[locale].excerpt || null, blocks: normalizeBlocks(payload.translations[locale].blocks), seoTitle: payload.translations[locale].seoTitle || null, seoDescription: payload.translations[locale].seoDescription || null })), { transaction });
    await writeRevision(kind, row, actorId, payload.changeSummary, transaction);
    await recordAudit({ actorId, action: `cms.${kind}_${id ? 'update' : 'create'}`, resourceType: kind, resourceId: row.id, after: { slug: row.slug, status: row.status, version: row.version }, request, transaction });
    if (row.status === 'published') await addDomainEvent({ topic: `content.${kind}.published`, aggregateType: kind, aggregateId: row.id, payload: { id: row.id, slug: row.slug }, transaction });
    return getAdminContentTransactional(kind, row.id, transaction);
  });
}

export async function listRevisions(kind, id) { const rows = await ContentRevision.findAll({ where: { entityType: kind, entityId: id }, order: [['version', 'DESC']], limit: 100 }); return rows.map((row) => ({ id: row.id, version: row.version, changeSummary: row.changeSummary, publishedAt: row.publishedAt, createdAt: row.createdAt })); }
export async function rollbackContent(kind, id, revisionId, expectedVersion, actorId, request) { const revision = await ContentRevision.findOne({ where: { id: revisionId, entityType: kind, entityId: id } }); if (!revision) throw AppError.notFound('Revision not found.'); return saveContent(kind, id, { ...revision.payload, status: 'draft', version: expectedVersion, changeSummary: `Rolled back from revision ${revision.version}` }, actorId, request); }

export async function listHomeAdmin() { const rows = await HomepageSection.findAll({ paranoid: false, order: [['displayOrder', 'ASC']] }); return rows.map((row) => ({ id: row.id, type: row.type, enabled: row.enabled, displayOrder: row.displayOrder, startsAt: row.startsAt, endsAt: row.endsAt, config: row.config, status: row.status, version: Number(row.version), archivedAt: row.deletedAt || null })); }
export async function saveHomeSection(id, payload, actorId, request) { return sequelize.transaction(async (transaction) => { let row = id ? await HomepageSection.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null; if (id && !row) throw AppError.notFound('Homepage section not found.'); if (row && Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'This homepage section changed.'); const values = { type: payload.type, enabled: payload.enabled, displayOrder: payload.displayOrder, startsAt: payload.startsAt || null, endsAt: payload.endsAt || null, config: sanitizeValue(payload.config), status: payload.status }; if (!row) row = await HomepageSection.create({ id: newId(), ...values, version: 1 }, { transaction }); else await row.update({ ...values, version: row.version + 1 }, { transaction }); await recordAudit({ actorId, action: 'cms.home_section_save', resourceType: 'homepage_section', resourceId: row.id, request, transaction }); return { ...values, id: row.id, version: Number(row.version) }; }); }

function menuAdminDto(row) { return { id: row.id, location: row.location, name: row.name, status: row.status, version: Number(row.version), items: (row.items || []).sort((a, b) => a.displayOrder - b.displayOrder).map((item) => ({ id: item.id, parentId: item.parentId, targetType: item.targetType, targetId: item.targetId, url: item.url, labelEn: item.labelEn, labelBn: item.labelBn, displayOrder: item.displayOrder, visible: item.visible })) }; }
export async function listMenusAdmin() { const rows = await Menu.findAll({ include: [{ model: MenuItem, as: 'items', required: false }], order: [['location', 'ASC']] }); return rows.map(menuAdminDto); }
export async function saveMenu(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    let row = id ? await Menu.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (id && !row) throw AppError.notFound('Menu not found.');
    if (row && Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'This menu changed. Refresh and review it.');
    const before = row ? { location: row.location, name: row.name, status: row.status, version: Number(row.version) } : null;
    if (!row) row = await Menu.create({ id: newId(), location: payload.location, name: payload.name, status: payload.status, version: 1 }, { transaction });
    else await row.update({ location: payload.location, name: payload.name, status: payload.status, version: row.version + 1 }, { transaction });
    await MenuItem.destroy({ where: { menuId: row.id }, transaction });
    const ids = new Map(payload.items.map((item) => [item.clientKey, newId()]));
    for (const [index, item] of payload.items.entries()) {
      if (item.parentKey && !ids.has(item.parentKey)) throw AppError.unprocessable('INVALID_MENU_PARENT', `Menu item ${index + 1} has an unknown parent.`);
      await MenuItem.create({ id: ids.get(item.clientKey), menuId: row.id, parentId: item.parentKey ? ids.get(item.parentKey) : null, targetType: item.targetType, targetId: item.targetType === 'url' ? null : item.targetId, url: item.targetType === 'url' ? validateUrl(item.url) : null, labelEn: item.labelEn, labelBn: item.labelBn, displayOrder: item.displayOrder, visible: item.visible }, { transaction });
    }
    await recordAudit({ actorId, action: 'cms.menu_save', resourceType: 'menu', resourceId: row.id, before, after: { location: row.location, name: row.name, status: row.status, version: Number(row.version), itemCount: payload.items.length }, request, transaction });
    return menuAdminDto(await Menu.findByPk(row.id, { include: [{ model: MenuItem, as: 'items' }], transaction }));
  });
}

export async function getThemeAdmin() { const rows = await ThemeSetting.findAll({ order: [['status', 'ASC'], ['updatedAt', 'DESC']] }); return rows.map((row) => ({ id: row.id, status: row.status, settings: row.settings, version: Number(row.version), publishedAt: row.publishedAt, updatedAt: row.updatedAt })); }
export async function saveTheme(payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const source = payload.sourceId ? await ThemeSetting.findByPk(payload.sourceId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (payload.sourceId && !source) throw AppError.notFound('Source theme settings not found.');
    if (source && Number(payload.version) !== Number(source.version)) throw AppError.conflict('VERSION_CONFLICT', 'Theme settings changed. Refresh and review the latest version.');
    let row = await ThemeSetting.findOne({ where: { status: payload.status }, transaction, lock: transaction.LOCK.UPDATE });
    if (!source && row && Number(payload.version) !== Number(row.version)) throw AppError.conflict('VERSION_CONFLICT', 'Theme settings changed. Refresh and review the latest version.');
    const settings = sanitizeValue(payload.settings);
    const before = row ? { id: row.id, status: row.status, settings: row.settings, version: Number(row.version) } : null;
    if (!row) row = await ThemeSetting.create({ id: newId(), status: payload.status, settings, version: 1, publishedAt: payload.status === 'published' ? new Date() : null }, { transaction });
    else await row.update({ settings, version: row.version + 1, publishedAt: payload.status === 'published' ? new Date() : row.publishedAt }, { transaction });
    await recordAudit({ actorId, action: payload.status === 'published' ? 'cms.theme_publish' : 'cms.theme_save', resourceType: 'theme', resourceId: row.id, before, after: { id: row.id, status: row.status, settings: row.settings, version: Number(row.version) }, request, transaction });
    return { id: row.id, status: row.status, settings: row.settings, version: Number(row.version), publishedAt: row.publishedAt };
  });
}
