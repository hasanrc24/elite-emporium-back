import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as products from './admin-product.service.js';
import { productMoneySchema, productSlugSchema, updateProductSchema } from './product.schemas.js';
import * as variantMatrix from './variant-matrix.service.js';

export const adminProductRouter = Router();
adminProductRouter.use(authenticate);

adminProductRouter.get('/products', requirePermission('catalog.view'), async (req, res) => {
  const result = await products.listAdminProducts(req.query);
  res.json({ ...result, requestId: req.id });
});
adminProductRouter.post('/products/bulk', requirePermission('catalog.manage'), validate(z.object({
  items: z.array(z.object({ id: z.string().length(26), version: z.number().int().positive() })).min(1).max(500),
  featured: z.boolean().optional(),
  visibility: z.enum(['catalog_search', 'catalog', 'search', 'hidden']).optional(),
  status: z.literal('draft').optional(),
}).refine((value) => value.featured != null || value.visibility || value.status, { message: 'Choose at least one change.' })), async (req, res) => {
  res.json({ data: await products.bulkUpdateProducts(req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminProductRouter.get('/products/:id', requirePermission('catalog.view'), async (req, res) => {
  res.json({ data: await products.getAdminProduct(req.params.id), meta: null, requestId: req.id });
});
adminProductRouter.patch('/products/:id', requirePermission('catalog.manage'), validate(updateProductSchema), async (req, res) => {
  res.json({ data: await products.updateProduct(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminProductRouter.post('/products/:id/publication', requirePermission('catalog.publish'), validate(z.object({
  version: z.number().int().positive(),
  status: z.enum(['draft', 'scheduled', 'published']),
  publishAt: z.iso.datetime().nullable().optional(),
})), async (req, res) => {
  res.json({ data: await products.changePublication(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminProductRouter.post('/products/:id/archive', requirePermission('catalog.manage'), validate(z.object({ version: z.number().int().positive() })), async (req, res) => {
  await products.archiveProduct(req.params.id, req.body.version, req.auth.user.id, req);
  res.status(204).end();
});
adminProductRouter.post('/products/:id/restore', requirePermission('catalog.manage'), async (req, res) => {
  res.json({ data: await products.restoreProduct(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminProductRouter.post('/products/:id/duplicate', requirePermission('catalog.manage'), validate(z.object({
  slug: productSlugSchema,
  skuPrefix: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).min(1).max(80),
  copyStock: z.boolean().default(false),
})), async (req, res) => {
  res.status(201).json({ data: await products.duplicateProduct(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});

const variationSelections = z.object({
  attributes: z.array(z.object({ attributeId: z.string().length(26), valueIds: z.array(z.string().length(26)).min(1).max(100) })).min(1).max(8),
  skuPrefix: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).min(1).max(60),
  locale: z.enum(['en', 'bn']).default('en'),
});
const matrixRow = z.object({
  signature: z.string().trim().min(1).max(1000),
  attributeValueIds: z.array(z.string().length(26)).min(1).max(8),
  sku: z.string().trim().min(1).max(100),
  barcode: z.string().trim().max(100).nullable().optional(),
  title: z.string().trim().min(1).max(180),
  attributes: z.record(z.string(), z.string()),
  regularPrice: productMoneySchema,
  salePrice: productMoneySchema.nullable().optional(),
  costPrice: productMoneySchema.nullable().optional(),
  saleStartsAt: z.iso.datetime().nullable().optional(),
  saleEndsAt: z.iso.datetime().nullable().optional(),
  stockPolicy: z.enum(['deny', 'allow_backorder', 'preorder']).default('deny'),
  preorderAvailableAt: z.iso.datetime().nullable().optional(),
  preorderMessage: z.string().trim().max(255).nullable().optional(),
  weightGrams: z.number().int().min(0).max(10_000_000).nullable().optional(),
  dimensions: z.object({ lengthCm: z.number().positive().nullable().optional(), widthCm: z.number().positive().nullable().optional(), heightCm: z.number().positive().nullable().optional() }).nullable().optional(),
  initialStock: z.number().int().min(0).max(1_000_000).default(0),
  lowStockThreshold: z.number().int().min(0).max(1_000_000).default(3),
}).superRefine((value, context) => {
  if (value.salePrice != null && Number(value.salePrice) >= Number(value.regularPrice)) context.addIssue({ code: 'custom', path: ['salePrice'], message: 'Sale price must be lower than regular price.' });
  if (value.saleStartsAt && value.saleEndsAt && value.saleStartsAt >= value.saleEndsAt) context.addIssue({ code: 'custom', path: ['saleEndsAt'], message: 'Sale end must be after sale start.' });
});

adminProductRouter.post('/products/:id/variants/generate-preview', requirePermission('catalog.manage'), validate(variationSelections), async (req, res) => {
  res.json({ data: await variantMatrix.previewVariantMatrix(req.params.id, req.body), meta: null, requestId: req.id });
});
adminProductRouter.post('/products/:id/variants/generate-commit', requirePermission('catalog.manage'), validate(z.object({ previewToken: z.string().min(40).max(100_000), rows: z.array(matrixRow).min(1).max(250) })), async (req, res) => {
  const data = await variantMatrix.commitVariantMatrix(req.params.id, req.body, req.auth.user.id, req.get('idempotency-key'), req);
  res.status(201).json({ data, meta: null, requestId: req.id });
});
adminProductRouter.patch('/variants/:id', requirePermission('catalog.manage'), validate(matrixRow.and(z.object({ version: z.number().int().positive(), isDefault: z.boolean() }))), async (req, res) => {
  res.json({ data: await variantMatrix.updateVariant(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminProductRouter.post('/variants/:id/archive', requirePermission('catalog.manage'), validate(z.object({ version: z.number().int().positive() })), async (req, res) => {
  await variantMatrix.archiveVariant(req.params.id, req.body.version, req.auth.user.id, req);
  res.status(204).end();
});
adminProductRouter.post('/variants/:id/restore', requirePermission('catalog.manage'), async (req, res) => {
  res.json({ data: await variantMatrix.restoreVariant(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id });
});
