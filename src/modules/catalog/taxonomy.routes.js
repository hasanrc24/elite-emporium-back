import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as taxonomies from './taxonomy.service.js';

export const adminTaxonomyRouter = Router();
adminTaxonomyRouter.use(authenticate);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180);
const id = z.string().length(26);
const localized = z.object({ en: z.object({ name: z.string().trim().min(1).max(180), description: z.string().max(20_000).default(''), seoTitle: z.string().max(255).nullable().optional(), seoDescription: z.string().max(500).nullable().optional() }), bn: z.object({ name: z.string().trim().min(1).max(180), description: z.string().max(20_000).default(''), seoTitle: z.string().max(255).nullable().optional(), seoDescription: z.string().max(500).nullable().optional() }) });
const base = { slug, mediaId: id.nullable().optional(), active: z.boolean().default(true), displayOrder: z.number().int().min(0).default(0), translations: localized };
const schemas = {
  categories: z.object({ ...base, parentId: id.nullable().optional() }),
  collections: z.object({ ...base, startsAt: z.iso.datetime().nullable().optional(), endsAt: z.iso.datetime().nullable().optional() }).refine((value) => !value.startsAt || !value.endsAt || value.startsAt < value.endsAt, { path: ['endsAt'], message: 'End must be after start.' }),
  brands: z.object(base),
};

for (const kind of ['categories', 'collections', 'brands']) {
  adminTaxonomyRouter.get(`/${kind}`, requirePermission('catalog.view'), async (req, res) => { const result = await taxonomies.listTaxonomies(kind, req.query); res.json({ ...result, requestId: req.id }); });
  adminTaxonomyRouter.post(`/${kind}`, requirePermission('catalog.manage'), validate(schemas[kind]), async (req, res) => res.status(201).json({ data: await taxonomies.createTaxonomy(kind, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminTaxonomyRouter.get(`/${kind}/:id`, requirePermission('catalog.view'), async (req, res) => res.json({ data: await taxonomies.getTaxonomy(kind, req.params.id), meta: null, requestId: req.id }));
  adminTaxonomyRouter.patch(`/${kind}/:id`, requirePermission('catalog.manage'), validate(schemas[kind].and(z.object({ version: z.number().int().positive() }))), async (req, res) => res.json({ data: await taxonomies.updateTaxonomy(kind, req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminTaxonomyRouter.post(`/${kind}/:id/archive`, requirePermission('catalog.manage'), async (req, res) => { await taxonomies.archiveTaxonomy(kind, req.params.id, req.auth.user.id, req); res.status(204).end(); });
  adminTaxonomyRouter.post(`/${kind}/:id/restore`, requirePermission('catalog.manage'), async (req, res) => res.json({ data: await taxonomies.restoreTaxonomy(kind, req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));
  adminTaxonomyRouter.post(`/${kind}/reorder`, requirePermission('catalog.manage'), validate(z.object({ items: z.array(z.object({ id, displayOrder: z.number().int().min(0), version: z.number().int().positive() })).min(1).max(500) })), async (req, res) => { await taxonomies.reorderTaxonomies(kind, req.body.items, req.auth.user.id, req); res.status(204).end(); });
}

const attributeValue = z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120), value: z.string().trim().min(1).max(180), colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), displayOrder: z.number().int().min(0).default(0), translations: z.object({ en: z.object({ label: z.string().trim().min(1).max(160) }), bn: z.object({ label: z.string().trim().min(1).max(160) }) }) });
const attributeSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), type: z.enum(['select', 'color', 'text']), filterable: z.boolean().default(true), variationCapable: z.boolean().default(true), displayOrder: z.number().int().min(0).default(0), translations: z.object({ en: z.object({ label: z.string().trim().min(1).max(160) }), bn: z.object({ label: z.string().trim().min(1).max(160) }) }), values: z.array(attributeValue).max(250).default([]) });
adminTaxonomyRouter.get('/attributes', requirePermission('catalog.view'), async (req, res) => res.json({ data: await taxonomies.listAdminAttributes(), meta: null, requestId: req.id }));
adminTaxonomyRouter.post('/attributes', requirePermission('catalog.manage'), validate(attributeSchema), async (req, res) => res.status(201).json({ data: await taxonomies.createAttribute(req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminTaxonomyRouter.get('/attributes/:id/usage', requirePermission('catalog.view'), async (req, res) => res.json({ data: await taxonomies.attributeUsage(req.params.id), meta: null, requestId: req.id }));
