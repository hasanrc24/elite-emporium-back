import { fileTypeFromBuffer } from "file-type";
import { QueryTypes } from "sequelize";
import { env } from "../../config/env.js";
import {
  AttributeValue,
  Brand,
  Category,
  Collection,
  ExportJob,
  MediaAsset,
  Post,
  ProductMedia,
  Shipment,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { recordAudit } from "../audits/audit.service.js";
import {
  mediaPublicUrl,
  persistOriginal,
  processImage,
} from "./media.storage.js";
import type { Request } from "express";
import type { DynamicModel } from "../../db/models/shared.js";

const imageTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
]);
const documentTypes = new Map([["application/pdf", "pdf"]]);

export function mediaDto(asset: DynamicModel) {
  const metadata = asset.metadata || {};
  return {
    id: asset.id,
    originalName: asset.originalName,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: Number(asset.byteSize),
    width: asset.width,
    height: asset.height,
    privacy: asset.privacy,
    status: asset.status,
    altText: asset.altText,
    url: asset.privacy === "public" ? mediaPublicUrl(asset.storageKey) : null,
    variants: metadata.variants || [],
    createdAt: asset.createdAt,
  };
}

export async function uploadMedia({
  file,
  privacy,
  altText,
  actorId,
  request,
  purpose = "library",
  metadata = {},
}: {
  file?: Express.Multer.File;
  privacy: "public" | "private";
  altText?: string | null;
  actorId?: string | null;
  request?: Request | null;
  purpose?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!file?.buffer?.length)
    throw AppError.unprocessable("FILE_REQUIRED", "Choose a file to upload.", {
      file: ["Choose a file to upload."],
    });
  const detected: RuntimeValue = await fileTypeFromBuffer(file.buffer);
  const extension =
    detected &&
    (imageTypes.get(detected.mime) || documentTypes.get(detected.mime));
  if (!detected || !extension)
    throw AppError.unprocessable(
      "UNSUPPORTED_MEDIA_TYPE",
      "Only JPEG, PNG, WebP, AVIF, and PDF files are allowed.",
    );
  const kind = imageTypes.has(detected.mime) ? "image" : "document";
  const maximumBytes =
    kind === "image" ? env.MEDIA_MAX_IMAGE_BYTES : env.MEDIA_MAX_DOCUMENT_BYTES;
  if (file.buffer.length > maximumBytes)
    throw AppError.unprocessable(
      "MEDIA_TOO_LARGE",
      `The selected ${kind} exceeds the allowed upload size.`,
    );
  const { storageKey, checksum }: RuntimeValue = await persistOriginal({
    buffer: file.buffer,
    privacy,
    extension,
  });
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const asset: RuntimeValue = await MediaAsset.create(
      {
        id: newId(),
        uploaderId: actorId,
        storageKey,
        originalName: file.originalname.slice(0, 255),
        kind,
        mimeType: detected.mime,
        byteSize: file.buffer.length,
        checksum,
        privacy,
        status: kind === "image" ? "processing" : "ready",
        altText: altText || null,
        metadata: { ...metadata, purpose },
      },
      { transaction },
    );
    if (kind === "image") {
      try {
        const processed: RuntimeValue = await processImage(storageKey);
        asset.width = processed.width;
        asset.height = processed.height;
        asset.metadata = { ...asset.metadata, variants: processed.variants };
        asset.status = "ready";
        await asset.save({ transaction });
      } catch (error: RuntimeValue) {
        asset.status = "failed";
        asset.metadata = {
          ...asset.metadata,
          processingError:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "processing_failed",
        };
        await asset.save({ transaction });
        throw AppError.unprocessable(
          "MEDIA_PROCESSING_FAILED",
          "The uploaded image could not be processed safely.",
        );
      }
    }
    await recordAudit({
      actorId,
      action: "media.upload",
      resourceType: "media",
      resourceId: asset.id,
      after: mediaDto(asset),
      request,
      transaction,
    });
    return mediaDto(asset);
  });
}

export async function updateMedia(
  id: string,
  payload: { altText?: string | null; privacy?: "public" | "private" },
  actorId: string,
  request: Request,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const asset: RuntimeValue = await MediaAsset.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!asset) throw AppError.notFound("Media asset not found.");
    const before: RuntimeValue = mediaDto(asset);
    if (payload.altText !== undefined) asset.altText = payload.altText || null;
    if (payload.privacy !== undefined && payload.privacy !== asset.privacy)
      throw AppError.conflict(
        "MEDIA_PRIVACY_IMMUTABLE",
        "Upload a new asset to change its privacy classification.",
      );
    await asset.save({ transaction });
    await recordAudit({
      actorId,
      action: "media.update",
      resourceType: "media",
      resourceId: asset.id,
      before,
      after: mediaDto(asset),
      request,
      transaction,
    });
    return mediaDto(asset);
  });
}

export async function archiveMedia(
  id: string,
  actorId: string,
  request: Request,
) {
  const usage: RuntimeValue = await mediaUsage(id);
  if (usage.inUse)
    throw AppError.conflict(
      "MEDIA_IN_USE",
      "Remove this asset from all products and content before archiving it.",
    );
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const asset: RuntimeValue = await MediaAsset.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!asset) throw AppError.notFound("Media asset not found.");
    const before: RuntimeValue = mediaDto(asset);
    asset.status = "archived";
    await asset.save({ transaction });
    await recordAudit({
      actorId,
      action: "media.archive",
      resourceType: "media",
      resourceId: asset.id,
      before,
      after: mediaDto(asset),
      request,
      transaction,
    });
    return mediaDto(asset);
  });
}

export async function mediaUsage(id: string) {
  const asset: RuntimeValue = await MediaAsset.findByPk(id);
  if (!asset) throw AppError.notFound("Media asset not found.");
  const [
    productMedia,
    categories,
    collections,
    brands,
    attributeValues,
    shipments,
    posts,
    exports,
    reviewMedia,
    returnMedia,
  ]: RuntimeValue = await Promise.all([
    ProductMedia.count({ where: { mediaId: id } }),
    Category.count({ where: { imageId: id }, paranoid: false }),
    Collection.count({ where: { imageId: id }, paranoid: false }),
    Brand.count({ where: { logoId: id }, paranoid: false }),
    AttributeValue.count({ where: { swatchMediaId: id }, paranoid: false }),
    Shipment.count({ where: { labelMediaId: id } }),
    Post.count({ where: { coverMediaId: id }, paranoid: false }),
    ExportJob.count({ where: { mediaId: id } }),
    sequelize.query(
      "SELECT COUNT(*) AS count FROM review_media WHERE mediaId = :id",
      { replacements: { id }, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      "SELECT COUNT(*) AS count FROM return_media WHERE mediaId = :id",
      { replacements: { id }, type: QueryTypes.SELECT },
    ),
  ]);
  const reviewCount = reviewMedia[0] as { count?: unknown } | undefined;
  const returnCount = returnMedia[0] as { count?: unknown } | undefined;
  const usages: RuntimeValue = {
    productMedia,
    categories,
    collections,
    brands,
    attributeValues,
    shipments,
    posts,
    exports,
    reviews: Number(reviewCount?.count || 0),
    returns: Number(returnCount?.count || 0),
  };
  return {
    id,
    inUse: Object.values(usages).some((count: RuntimeValue) => count > 0),
    usages,
  };
}
