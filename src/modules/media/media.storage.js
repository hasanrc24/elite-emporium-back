import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../../config/env.js';

const directories = ['incoming', 'public/original', 'public/derived', 'private/original', 'private/derived', 'quarantine'];

export async function ensureMediaDirectories() {
  await Promise.all(directories.map((directory) => mkdir(path.join(env.MEDIA_ROOT, directory), { recursive: true, mode: 0o750 })));
}

export function absoluteMediaPath(storageKey) {
  const root = path.resolve(env.MEDIA_ROOT);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe media storage key');
  return resolved;
}

export function mediaPublicUrl(storageKey) {
  if (!storageKey.startsWith('public/')) return null;
  return `${env.MEDIA_PUBLIC_ORIGIN.replace(/\/$/, '')}/${storageKey}`;
}

export async function persistOriginal({ buffer, privacy, extension }) {
  await ensureMediaDirectories();
  const now = new Date();
  const relative = `${privacy}/original/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(24).toString('hex')}.${extension}`;
  const destination = absoluteMediaPath(relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  await writeFile(destination, buffer, { flag: 'wx', mode: 0o640 });
  return { storageKey: relative, checksum: createHash('sha256').update(buffer).digest('hex') };
}

export async function processImage(storageKey) {
  const inputPath = absoluteMediaPath(storageKey);
  const metadata = await sharp(inputPath, { failOn: 'warning', limitInputPixels: 50_000_000 }).metadata();
  const baseName = path.basename(storageKey, path.extname(storageKey));
  const privacy = storageKey.split('/')[0];
  const variants = [];
  for (const width of [480, 960, 1600]) {
    if (metadata.width && width > metadata.width) continue;
    const relative = `${privacy}/derived/${baseName}-${width}.webp`;
    const destination = absoluteMediaPath(relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
    await sharp(inputPath, { failOn: 'warning', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(destination);
    variants.push({ width, storageKey: relative, url: mediaPublicUrl(relative) });
  }
  return { width: metadata.width || null, height: metadata.height || null, variants };
}

export async function readMedia(storageKey) {
  return readFile(absoluteMediaPath(storageKey));
}

export function signPrivateMedia(assetId, expiresAt) {
  return createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(`${assetId}.${expiresAt}`).digest('base64url');
}

export function verifyPrivateMediaSignature(assetId, expiresAt, signature) {
  const expires = Number(expiresAt);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signPrivateMedia(assetId, expires), 'base64url');
  const actual = Buffer.from(String(signature || ''), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
