import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as inventory from './inventory.service.js';

export const adminInventoryRouter = Router();
adminInventoryRouter.use(authenticate);
const id = z.string().length(26);
const adjustment = z.object({ variantId: id, locationId: id, delta: z.number().int().min(-1_000_000).max(1_000_000).optional(), countedQuantity: z.number().int().min(0).max(1_000_000).optional(), lowStockThreshold: z.number().int().min(0).max(1_000_000).optional(), reason: z.enum(['purchase_receipt', 'manual_correction', 'damage', 'loss', 'return_restock', 'stock_count', 'initial_stock', 'other']), note: z.string().trim().max(500).optional(), version: z.number().int().positive() }).refine((value) => (value.delta == null) !== (value.countedQuantity == null), { message: 'Provide either delta or countedQuantity.', path: ['delta'] });
const location = z.object({ code: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(60), name: z.string().trim().min(1).max(160), address: z.record(z.string(), z.unknown()).nullable().optional(), active: z.boolean().default(true) });

adminInventoryRouter.get('/inventory/levels', requirePermission('inventory.view'), async (req, res) => { const result = await inventory.listLevels(req.query); res.json({ ...result, requestId: req.id }); });
adminInventoryRouter.get('/inventory/low-stock', requirePermission('inventory.view'), async (req, res) => { const result = await inventory.listLevels({ ...req.query, lowStock: 'true' }); res.json({ ...result, requestId: req.id }); });
adminInventoryRouter.get('/inventory/movements', requirePermission('inventory.view'), async (req, res) => { const result = await inventory.listMovements(req.query); res.json({ ...result, requestId: req.id }); });
adminInventoryRouter.post('/inventory/adjustments', requirePermission('inventory.adjust'), validate(adjustment), async (req, res) => res.json({ data: await inventory.adjustInventory(req.body, req.auth.user.id, req.get('idempotency-key'), req), meta: null, requestId: req.id }));
adminInventoryRouter.post('/inventory/reconciliations', requirePermission('inventory.adjust'), validate(adjustment), async (req, res) => res.json({ data: await inventory.adjustInventory(req.body, req.auth.user.id, req.get('idempotency-key'), req), meta: null, requestId: req.id }));
adminInventoryRouter.get('/inventory/locations', requirePermission('inventory.view'), async (req, res) => res.json({ data: await inventory.listLocations(), meta: null, requestId: req.id }));
adminInventoryRouter.post('/inventory/locations', requirePermission('inventory.adjust'), validate(location), async (req, res) => res.status(201).json({ data: await inventory.createLocation(req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminInventoryRouter.patch('/inventory/locations/:id', requirePermission('inventory.adjust'), validate(location.and(z.object({ version: z.number().int().positive() }))), async (req, res) => res.json({ data: await inventory.updateLocation(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
