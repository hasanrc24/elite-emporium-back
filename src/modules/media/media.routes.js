import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, requirePermission } from '../../app/middleware/authenticate.js';
import { validate } from '../../app/middleware/validate.js';
import { MediaAsset } from '../../db/models.js';
import { AppError } from '../../lib/errors.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import * as media from './media.service.js';
import { readMedia, signPrivateMedia, verifyPrivateMediaSignature } from './media.storage.js';

export const adminMediaRouter = Router();
export const mediaRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(env.MEDIA_MAX_IMAGE_BYTES, env.MEDIA_MAX_DOCUMENT_BYTES), files: 1, fields: 10 } });

adminMediaRouter.use(authenticate, requirePermission('media.manage'));
adminMediaRouter.get('/', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req.query);
  const result = await MediaAsset.findAndCountAll({ limit, offset, order: [['createdAt', 'DESC']] });
  result.rows = result.rows.map(media.mediaDto);
  res.json({ ...pageEnvelope(result, page, pageSize), requestId: req.id });
});
adminMediaRouter.get('/:id/status', async (req, res) => { const asset = await MediaAsset.findByPk(req.params.id); if (!asset) throw AppError.notFound('Media asset not found.'); res.json({ data: media.mediaDto(asset), meta: null, requestId: req.id }); });
adminMediaRouter.get('/:id/usage', async (req, res) => res.json({ data: await media.mediaUsage(req.params.id), meta: null, requestId: req.id }));
adminMediaRouter.post('/upload', upload.single('file'), async (req, res) => {
  const request = /** @type {any} */ (req);
  const uploadedFile = request.file;
  const privacy = req.body.privacy === 'private' ? 'private' : 'public';
  const data = await media.uploadMedia({ file: uploadedFile, privacy, altText: req.body.altText, actorId: req.auth.user.id, request: req, purpose: 'library' });
  res.status(201).json({ data, meta: null, requestId: req.id });
});

mediaRouter.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  const request = /** @type {any} */ (req);
  const purpose = req.body.purpose === 'return' ? 'return' : 'review';
  const data = await media.uploadMedia({ file: request.file, privacy: purpose === 'return' ? 'private' : 'public', altText: req.body.altText, actorId: req.auth.user.id, request: req, purpose });
  res.status(201).json({ data, meta: null, requestId: req.id });
});
mediaRouter.post('/:id/signed-url', authenticate, async (req, res) => {
  const asset = await MediaAsset.findByPk(req.params.id);
  if (!asset || asset.privacy !== 'private' || asset.status !== 'ready' || (asset.uploaderId !== req.auth.user.id && !req.auth.permissions.has('media.manage'))) throw AppError.notFound('Private media asset not found.');
  const expiresAt = Math.floor(Date.now() / 1000) + env.MEDIA_PRIVATE_URL_TTL_SECONDS;
  const signature = signPrivateMedia(asset.id, expiresAt);
  res.json({ data: { url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`, expiresAt: new Date(expiresAt * 1000).toISOString() }, meta: null, requestId: req.id });
});
adminMediaRouter.patch('/:id', validate(z.object({ altText: z.string().trim().max(500).nullable().optional(), privacy: z.enum(['public', 'private']).optional() })), async (req, res) => res.json({ data: await media.updateMedia(req.params.id, req.body, req.auth.user.id, req), meta: null, requestId: req.id }));
adminMediaRouter.delete('/:id', async (req, res) => res.json({ data: await media.archiveMedia(req.params.id, req.auth.user.id, req), meta: null, requestId: req.id }));
adminMediaRouter.post('/:id/signed-url', async (req, res) => {
  const asset = await MediaAsset.findByPk(req.params.id);
  if (!asset || asset.privacy !== 'private' || asset.status !== 'ready') throw AppError.notFound('Private media asset not found.');
  const expiresAt = Math.floor(Date.now() / 1000) + env.MEDIA_PRIVATE_URL_TTL_SECONDS;
  const signature = signPrivateMedia(asset.id, expiresAt);
  res.json({ data: { url: `${env.API_BASE_PATH}/media/${asset.id}/download?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`, expiresAt: new Date(expiresAt * 1000).toISOString() }, meta: null, requestId: req.id });
});

mediaRouter.get('/:id/download', async (req, res) => {
  const asset = await MediaAsset.findByPk(req.params.id);
  if (!asset || asset.privacy !== 'private' || asset.status !== 'ready' || !verifyPrivateMediaSignature(asset.id, req.query.expires, req.query.signature)) throw AppError.notFound('Private media asset not found.');
  const buffer = await readMedia(asset.storageKey);
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `attachment; filename="${String(asset.originalName).replace(/["\r\n]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
});
