import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as content from './content.service.js';

export const contentRouter = Router();
export const adminContentRouter = Router();
const locale = (req) => ['en', 'bn'].includes(req.query.locale) ? req.query.locale : 'en';
const block = z.object({ id: z.string().max(80).optional(), type: z.enum(['rich_text', 'image', 'hero', 'banner', 'product_carousel', 'category_grid', 'collection_grid', 'countdown', 'testimonials', 'faq', 'newsletter', 'blog_feed']), data: z.record(z.string(), z.unknown()).default({}) });
const translated = z.object({ title: z.string().trim().min(1).max(255), excerpt: z.string().max(5000).optional().default(''), blocks: z.array(block).max(100).default([]), seoTitle: z.string().max(255).optional().default(''), seoDescription: z.string().max(500).optional().default('') });
const common = { slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180), status: z.enum(['draft', 'scheduled', 'published']).default('draft'), publishAt: z.iso.datetime().nullable().optional(), translations: z.object({ en: translated, bn: translated }), changeSummary: z.string().max(500).optional() };
const pageSchema = z.object({ ...common, template: z.string().max(80).default('standard'), version: z.number().int().positive().optional() });
const postSchema = z.object({ ...common, type: z.enum(['blog', 'lookbook']).default('blog'), categoryId: z.string().length(26).nullable().optional(), coverMediaId: z.string().length(26).nullable().optional(), version: z.number().int().positive().optional() });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: 'draft-8', legacyHeaders: false });

contentRouter.get('/storefront/navigation', async (req, res) => res.json({ data: await content.storefrontNavigation(locale(req)), meta: null, requestId: req.id }));
contentRouter.get('/storefront/home', async (req, res) => res.json({ data: await content.storefrontHome(locale(req)), meta: null, requestId: req.id }));
contentRouter.get('/pages/:slug', async (req, res) => res.json({ data: await content.getPublicPage(req.params.slug, locale(req)), meta: null, requestId: req.id }));
contentRouter.get('/posts', async (req, res) => { const result = await content.listPublicPosts(req.query, locale(req)); res.json({ ...result, requestId: req.id }); });
contentRouter.get('/posts/:slug', async (req, res) => res.json({ data: await content.getPublicPost(req.params.slug, locale(req)), meta: null, requestId: req.id }));
contentRouter.get('/sitemap-data', async (req, res) => res.json({ data: await content.sitemapData(), meta: null, requestId: req.id }));
contentRouter.post('/contact', contactLimiter, validate(z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional().default(''), email: z.union([z.literal(''), z.email().max(190)]).optional().default(''), subject: z.string().trim().min(2).max(180), message: z.string().trim().min(10).max(10_000) })), async (req, res) => res.status(202).json({ data: await content.submitContact(req.body, req), meta: null, requestId: req.id }));

adminContentRouter.use(authenticate);
for (const [kind, schema] of /** @type {Array<[string, any]>} */ ([['page', pageSchema], ['post', postSchema]])) {
  const plural = `${kind}s`;
  adminContentRouter.get(`/${plural}`, requirePermission('cms.manage'), async (req, res) => { const result = await content.listAdminContent(kind, req.query); res.json({ ...result, requestId: req.id }); });
  adminContentRouter.post(`/${plural}`, requirePermission('cms.manage'), validate(schema), async (req, res) => res.status(201).json({ data: await content.saveContent(kind, null, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminContentRouter.get(`/${plural}/:id`, requirePermission('cms.manage'), async (req, res) => res.json({ data: await content.getAdminContent(kind, req.params.id), meta: null, requestId: req.id }));
  adminContentRouter.patch(`/${plural}/:id`, requirePermission('cms.manage'), validate(schema.extend({ version: z.number().int().positive() })), async (req, res) => res.json({ data: await content.saveContent(kind, req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminContentRouter.get(`/${plural}/:id/revisions`, requirePermission('cms.manage'), async (req, res) => res.json({ data: await content.listRevisions(kind, req.params.id), meta: null, requestId: req.id }));
  adminContentRouter.post(`/${plural}/:id/rollback`, requirePermission('cms.publish'), validate(z.object({ revisionId: z.string().length(26), version: z.number().int().positive() })), async (req, res) => res.json({ data: await content.rollbackContent(kind, req.params.id, req.body.revisionId, req.body.version, req.auth.user.id, req), meta: null, requestId: req.id }));
}
const homeSchema = z.object({ type: z.enum(['hero', 'banner', 'product_carousel', 'category_grid', 'collection_grid', 'countdown', 'testimonials', 'editorial', 'newsletter', 'blog_feed']), enabled: z.boolean(), displayOrder: z.number().int().min(0), startsAt: z.iso.datetime().nullable().optional(), endsAt: z.iso.datetime().nullable().optional(), config: z.record(z.string(), z.unknown()), status: z.enum(['draft', 'published']), version: z.number().int().positive().optional() });
adminContentRouter.get('/home-sections', requirePermission('cms.manage'), async (req, res) => res.json({ data: await content.listHomeAdmin(), meta: null, requestId: req.id }));
adminContentRouter.post('/home-sections', requirePermission('cms.manage'), validate(homeSchema), async (req, res) => res.status(201).json({ data: await content.saveHomeSection(null, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminContentRouter.patch('/home-sections/:id', requirePermission('cms.manage'), validate(homeSchema.extend({ version: z.number().int().positive() })), async (req, res) => res.json({ data: await content.saveHomeSection(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
const menuItem = z.object({ clientKey: z.string().trim().min(1).max(80), parentKey: z.string().trim().min(1).max(80).nullable().optional(), targetType: z.enum(['url', 'product', 'category', 'collection', 'page']), targetId: z.string().length(26).nullable().optional(), url: z.string().max(1000).nullable().optional(), labelEn: z.string().trim().min(1).max(180), labelBn: z.string().trim().min(1).max(180), displayOrder: z.number().int().min(0), visible: z.boolean() });
const menuSchema = z.object({ location: z.string().regex(/^[a-z0-9_-]+$/).max(80), name: z.string().trim().min(2).max(160), status: z.enum(['draft', 'published']), items: z.array(menuItem).max(100), version: z.number().int().positive().optional() });
adminContentRouter.get('/menus', requirePermission('cms.manage'), async (req, res) => res.json({ data: await content.listMenusAdmin(), meta: null, requestId: req.id }));
adminContentRouter.post('/menus', requirePermission('cms.manage'), validate(menuSchema), async (req, res) => res.status(201).json({ data: await content.saveMenu(null, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminContentRouter.patch('/menus/:id', requirePermission('cms.manage'), validate(menuSchema.extend({ version: z.number().int().positive() })), async (req, res) => res.json({ data: await content.saveMenu(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminContentRouter.get('/theme', requirePermission('cms.manage'), async (req, res) => res.json({ data: await content.getThemeAdmin(), meta: null, requestId: req.id }));
const safeUrl = z.union([z.literal(''), z.string().url().max(1000)]).nullable().optional();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const themeSettings = z.object({ primary: color, accent: color, background: color, text: color, radius: z.enum(['0rem', '0.25rem', '0.5rem', '0.75rem', '1rem', '1.5rem']), fontHeading: z.enum(['system', 'serif', 'sans']).optional(), fontBody: z.enum(['system', 'serif', 'sans']).optional(), logoUrl: safeUrl, faviconUrl: safeUrl, header: z.object({ sticky: z.boolean().default(true), showSearch: z.boolean().default(true) }).optional(), footer: z.object({ showContact: z.boolean().default(true), showSocial: z.boolean().default(true) }).optional(), productCard: z.object({ showRating: z.boolean().default(true), showQuickAdd: z.boolean().default(false) }).optional(), announcement: z.object({ enabled: z.boolean(), textEn: z.string().max(255), textBn: z.string().max(255), url: safeUrl }).optional() }).strict();
adminContentRouter.put('/theme', requirePermission('cms.publish'), validate(z.object({ status: z.enum(['draft', 'published']), settings: themeSettings, version: z.number().int().positive(), sourceId: z.string().length(26).optional() })), async (req, res) => res.json({ data: await content.saveTheme(req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
