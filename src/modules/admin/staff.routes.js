import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import * as roles from './role.service.js';
import * as staff from './staff.service.js';

export const adminStaffRouter = Router();
adminStaffRouter.use(authenticate);

const id = z.string().length(26);
adminStaffRouter.get('/staff', requirePermission('staff.view'), async (req, res) => {
  const result = await staff.listStaff(req.query);
  res.json({ ...result, requestId: req.id });
});
adminStaffRouter.post('/staff', requirePermission('staff.manage'), requirePermission('roles.manage'), validate(z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.email().max(190).nullable().optional(),
  locale: z.enum(['en', 'bn']).default('en'),
  roleIds: z.array(id).min(1).max(20),
})), async (req, res) => {
  res.status(201).json({ data: await staff.createStaff(req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.get('/staff/:id', requirePermission('staff.view'), async (req, res) => {
  res.json({ data: await staff.getStaff(req.params.id), meta: null, requestId: req.id });
});
adminStaffRouter.patch('/staff/:id', requirePermission('staff.manage'), validate(z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullable(),
  email: z.union([z.email().max(190), z.null()]),
  locale: z.enum(['en', 'bn']),
  status: z.enum(['active', 'disabled']),
  version: z.number().int().positive(),
})), async (req, res) => {
  res.json({ data: await staff.updateStaffProfile(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.put('/staff/:id/access', requirePermission('roles.manage'), validate(z.object({
  version: z.number().int().positive(),
  roleIds: z.array(id).min(1).max(20),
  overrides: z.array(z.object({ permissionId: id, allow: z.boolean(), reason: z.string().trim().min(3).max(255) })).max(500).default([]),
  reason: z.string().trim().min(3).max(500),
})), async (req, res) => {
  res.json({ data: await staff.updateStaffAccess(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.post('/staff/:id/password-reset', requirePermission('staff.manage'), async (req, res) => {
  res.json({ data: await staff.resetStaffPassword(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.get('/staff/:id/sessions', requirePermission('staff.manage'), async (req, res) => {
  res.json({ data: await staff.listStaffSessions(req.params.id), meta: null, requestId: req.id });
});
adminStaffRouter.delete('/staff/:id/sessions/:sessionId', requirePermission('staff.manage'), async (req, res) => {
  await staff.revokeStaffSession(req.params.id, req.params.sessionId, req.auth.user.id, req);
  res.status(204).end();
});

const roleSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).min(2).max(60),
  name: z.string().trim().min(2).max(100),
  permissionIds: z.array(id).max(500).default([]),
});
adminStaffRouter.get('/permissions', requirePermission('roles.manage'), async (req, res) => {
  res.json({ data: await roles.listPermissions(), meta: null, requestId: req.id });
});
adminStaffRouter.get('/roles', requirePermission('staff.view'), async (req, res) => {
  res.json({ data: await roles.listRoles(), meta: null, requestId: req.id });
});
adminStaffRouter.post('/roles', requirePermission('roles.manage'), validate(roleSchema), async (req, res) => {
  res.status(201).json({ data: await roles.createRole(req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.patch('/roles/:id', requirePermission('roles.manage'), validate(roleSchema.omit({ key: true }).and(z.object({ version: z.number().int().positive(), active: z.boolean(), reason: z.string().trim().min(3).max(500) }))), async (req, res) => {
  res.json({ data: await roles.updateRole(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.post('/roles/:id/archive', requirePermission('roles.manage'), validate(z.object({ version: z.number().int().positive() })), async (req, res) => {
  res.json({ data: await roles.archiveRole(req.params.id, req.body.version, req.auth.user.id, req), meta: null, requestId: req.id });
});
adminStaffRouter.get('/roles/owner-invariant', requirePermission('roles.manage'), async (req, res) => {
  res.json({ data: await roles.ownerInvariantSummary(req.auth.user.id), meta: null, requestId: req.id });
});

