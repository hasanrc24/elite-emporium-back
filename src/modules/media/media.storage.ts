import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../../config/env.js";

const directories = [
  "incoming",
  "public/original",
  "public/derived",
  "private/original",
  "private/derived",
  "quarantine",
];

export async function ensureMediaDirectories() {
  await Promise.all(
    directories.map((directory) =>
      mkdir(path.join(env.MEDIA_ROOT, directory), {
        recursive: true,
        mode: 0o750,
      }),
    ),
  );
}

function absoluteMediaPath(storageKey: string): string {
  const root = path.resolve(env.MEDIA_ROOT);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error("Unsafe media storage key");
  return resolved;
}

export function mediaPublicUrl(storageKey: string): string | null {
  if (!storageKey.startsWith("public/")) return null;
  return `${env.MEDIA_PUBLIC_ORIGIN.replace(/\/$/, "")}/${storageKey}`;
}

export async function persistOriginal({
  buffer,
  privacy,
  extension,
}: {
  buffer: Buffer;
  privacy: "public" | "private";
  extension: string;
}) {
  await ensureMediaDirectories();
  const now = new Date();
  const relative = `${privacy}/original/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomBytes(24).toString("hex")}.${extension}`;
  const destination = absoluteMediaPath(relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  await writeFile(destination, buffer, { flag: "wx", mode: 0o640 });
  return {
    storageKey: relative,
    checksum: createHash("sha256").update(buffer).digest("hex"),
  };
}

const derivedWidths = [480, 960, 1600];
const derivedFormats = ["webp", "avif"] as const;
const inputLimits = {
  failOn: "warning",
  limitInputPixels: 50_000_000,
} as const;

function derivedKey(
  storageKey: string,
  width: number,
  format: (typeof derivedFormats)[number] = "webp",
): string {
  const baseName = path.basename(storageKey, path.extname(storageKey));
  const privacy = storageKey.split("/")[0];
  return `${privacy}/derived/${baseName}-${width}.${format}`;
}

/** Removes an original and any derived files written for it. */
export async function discardMedia(storageKey: string) {
  await Promise.all(
    [
      storageKey,
      ...derivedWidths.flatMap((width) =>
        derivedFormats.map((format) => derivedKey(storageKey, width, format)),
      ),
    ].map((key) => rm(absoluteMediaPath(key), { force: true })),
  );
}

/**
 * Re-encodes an upload in its own format with orientation applied and all
 * metadata (EXIF GPS, camera, XMP) dropped, so the publicly served original
 * never leaks the uploader's location. Throws for undecodable input.
 */
export async function stripImageMetadata(
  buffer: Buffer,
  mime: string,
): Promise<Buffer> {
  const pipeline = sharp(buffer, inputLimits).rotate();
  if (mime === "image/jpeg")
    return pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  if (mime === "image/png") return pipeline.png().toBuffer();
  if (mime === "image/webp") return pipeline.webp({ quality: 92 }).toBuffer();
  if (mime === "image/avif") return pipeline.avif({ quality: 70 }).toBuffer();
  return buffer;
}

export async function processImage(storageKey: string) {
  const inputPath = absoluteMediaPath(storageKey);
  const metadata = await sharp(inputPath, inputLimits).metadata();
  const variants: {
    width: number;
    format: string;
    storageKey: string;
    url: string | null;
  }[] = [];
  for (const width of derivedWidths) {
    if (metadata.width && width > metadata.width) continue;
    for (const format of derivedFormats) {
      const relative = derivedKey(storageKey, width, format);
      const destination = absoluteMediaPath(relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
      const pipeline = sharp(inputPath, inputLimits)
        .rotate()
        .resize({ width, withoutEnlargement: true });
      await (
        format === "webp"
          ? pipeline.webp({ quality: 82, effort: 4 })
          : pipeline.avif({ quality: 55, effort: 2 })
      ).toFile(destination);
      variants.push({
        width,
        format,
        storageKey: relative,
        url: mediaPublicUrl(relative),
      });
    }
  }
  return {
    width: metadata.width || null,
    height: metadata.height || null,
    variants,
  };
}

export async function readMedia(storageKey: string) {
  return readFile(absoluteMediaPath(storageKey));
}

export function signPrivateMedia(assetId: string, expiresAt: number): string {
  return createHmac("sha256", env.MEDIA_SIGNING_SECRET)
    .update(`${assetId}.${expiresAt}`)
    .digest("base64url");
}

export function verifyPrivateMediaSignature(
  assetId: string,
  expiresAt: unknown,
  signature: unknown,
): boolean {
  const expires = Number(expiresAt);
  if (
    !Number.isSafeInteger(expires) ||
    expires <= Math.floor(Date.now() / 1000)
  )
    return false;
  const expected = Buffer.from(signPrivateMedia(assetId, expires), "base64url");
  const actual = Buffer.from(String(signature || ""), "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
