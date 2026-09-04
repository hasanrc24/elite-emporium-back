import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import { getPublicSettings, getSettingGroup, listSettingGroups, updateSettingGroup } from './settings.service.js';

export const settingsRouter = Router();
export const storefrontRouter = Router();

storefrontRouter.get('/settings', async (req, res) => res.json({ data: await getPublicSettings(), meta: null, requestId: req.id }));

settingsRouter.use(authenticate, requirePermission('settings.manage'));
settingsRouter.get('/', async (req, res) => res.json({ data: await listSettingGroups(), meta: null, requestId: req.id }));
settingsRouter.get('/:key', async (req, res) => res.json({ data: await getSettingGroup(req.params.key), meta: null, requestId: req.id }));
settingsRouter.put('/:key', validate(z.object({ value: z.unknown(), version: z.number().int().min(0) })), async (req, res) => res.json({ data: await updateSettingGroup(req.params.key, req.body.value, req.body.version, req.auth.user.id, req), meta: null, requestId: req.id }));
