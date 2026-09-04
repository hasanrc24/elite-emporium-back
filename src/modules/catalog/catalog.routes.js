import { Router } from 'express';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as catalog from './catalog.service.js';
import { createProductSchema } from './product.schemas.js';

export const catalogRouter = Router();
export const adminCatalogRouter = Router();
const locale = (req) => ['en', 'bn'].includes(req.query.locale) ? req.query.locale : 'en';

catalogRouter.get('/products', async (req, res) => { const result = await catalog.listProducts({ ...req.query, locale: locale(req) }); res.json({ ...result, requestId: req.id }); });
catalogRouter.get('/products/:slug', async (req, res) => res.json({ data: await catalog.getProduct(req.params.slug, locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/categories', async (req, res) => res.json({ data: await catalog.listCategories(locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/categories/:slug', async (req, res) => res.json({ data: await catalog.getCategory(req.params.slug, locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/collections', async (req, res) => res.json({ data: await catalog.listCollections(locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/collections/:slug', async (req, res) => res.json({ data: await catalog.getCollection(req.params.slug, locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/brands', async (req, res) => res.json({ data: await catalog.listBrands(locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/attributes', async (req, res) => res.json({ data: await catalog.listAttributes(locale(req)), meta: null, requestId: req.id }));
catalogRouter.get('/search', async (req, res) => { const result = await catalog.listProducts({ ...req.query, search: req.query.q, locale: locale(req) }); res.json({ ...result, requestId: req.id }); });
catalogRouter.get('/search/suggestions', async (req, res) => res.json({ data: await catalog.searchSuggestions(req.query.q, locale(req)), meta: null, requestId: req.id }));

adminCatalogRouter.post('/products', authenticate, requirePermission('catalog.manage'), validate(createProductSchema), async (req, res) => res.status(201).json({ data: catalog.publicProduct(await catalog.createProduct(req.body, req.auth.user.id, req), 'en', true), meta: null, requestId: req.id }));
