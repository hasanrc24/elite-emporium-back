import { fileTypeFromBuffer } from "file-type";
import { Op, QueryTypes, literal } from "sequelize";
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
import { likeContains } from "../../lib/like.js";
import { pageEnvelope, pagination } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import {
  discardMedia,
  mediaPublicUrl,
  persistOriginal,
  processImage,
  stripImageMetadata,
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
    purpose: metadata.purpose || "library",
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
  allowDocuments = true,
}: {
  file?: Express.Multer.File;
  privacy: "public" | "private";
  altText?: string | null;
  actorId?: string | null;
  request?: Request | null;
  purpose?: string;
  metadata?: Record<string, unknown>;
  allowDocuments?: boolean;
}) {
  if (!file?.buffer?.length)
    throw AppError.unprocessable("FILE_REQUIRED", "Choose a file to upload.", {
      file: ["Choose a file to upload."],
    });
  const detected: RuntimeValue = await fileTypeFromBuffer(file.buffer);
  const extension =
    detected &&
    (imageTypes.get(detected.mime) ||
      (allowDocuments ? documentTypes.get(detected.mime) : undefined));
  if (!detected || !extension)
    throw AppError.unprocessable(
      "UNSUPPORTED_MEDIA_TYPE",
      allowDocuments
        ? "Only JPEG, PNG, WebP, AVIF, and PDF files are allowed."
        : "Only JPEG, PNG, WebP, and AVIF images are allowed.",
    );
  const kind = imageTypes.has(detected.mime) ? "image" : "document";
  const maximumBytes =
    kind === "image" ? env.MEDIA_MAX_IMAGE_BYTES : env.MEDIA_MAX_DOCUMENT_BYTES;
  if (file.buffer.length > maximumBytes)
    throw AppError.unprocessable(
      "MEDIA_TOO_LARGE",
      `The selected ${kind} exceeds the allowed upload size.`,
    );
  let content = file.buffer;
  if (kind === "image") {
    try {
      content = await stripImageMetadata(file.buffer, detected.mime);
    } catch {
      throw AppError.unprocessable(
        "MEDIA_PROCESSING_FAILED",
        "The uploaded image could not be processed safely.",
      );
    }
  }
  const { storageKey, checksum }: RuntimeValue = await persistOriginal({
    buffer: content,
    privacy,
    extension,
  });
  try {
    // Decode before opening the transaction; a failed upload leaves neither a
    // row nor orphaned files behind.
    let processed: RuntimeValue = null;
    if (kind === "image") {
      try {
        processed = await processImage(storageKey);
      } catch {
        throw AppError.unprocessable(
          "MEDIA_PROCESSING_FAILED",
          "The uploaded image could not be processed safely.",
        );
      }
    }
    return await sequelize.transaction(async (transaction: RuntimeValue) => {
      const asset: RuntimeValue = await MediaAsset.create(
        {
          id: newId(),
          uploaderId: actorId,
          storageKey,
          originalName: file.originalname.slice(0, 255),
          kind,
          mimeType: detected.mime,
          byteSize: content.length,
          checksum,
          privacy,
          status: "ready",
          width: processed?.width ?? null,
          height: processed?.height ?? null,
          altText: altText || null,
          metadata: {
            ...metadata,
            purpose,
            ...(processed ? { variants: processed.variants } : {}),
          },
        },
        { transaction },
      );
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
  } catch (error) {
    await discardMedia(storageKey).catch(() => undefined);
    throw error;
  }
}

// Files created for exports and customer evidence are not library content.
const hiddenPurposes = literal(
  "(JSON_UNQUOTE(JSON_EXTRACT(`MediaAsset`.`metadata`, '$.purpose')) IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(`MediaAsset`.`metadata`, '$.purpose')) NOT IN ('export', 'return', 'review'))",
);

/** The media library: archived files are hidden unless asked for. */
export async function listMedia(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = { [Op.and]: [hiddenPurposes] };
  if (query.status === "archived") where.status = "archived";
  else if (query.status !== "all") where.status = { [Op.ne]: "archived" };
  if (query.kind === "image" || query.kind === "document")
    where.kind = query.kind;
  if (typeof query.search === "string" && query.search.trim())
    where.originalName = { [Op.like]: likeContains(query.search.trim(), 100) };
  const result: RuntimeValue = await MediaAsset.findAndCountAll({
    where,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return pageEnvelope(
    { rows: result.rows.map(mediaDto), count: result.count },
    page,
    pageSize,
  );
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

/**
 * Deletes several files at once. Each file is checked on its own, so files
 * that are still in use are skipped and reported instead of failing the lot.
 */
export async function archiveManyMedia(
  ids: string[],
  actorId: string,
  request: Request,
) {
  const archived: string[] = [];
  const skipped: { id: string; name: string | null; reason: string }[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      await archiveMedia(id, actorId, request);
      archived.push(id);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const asset: RuntimeValue = await MediaAsset.findByPk(id, {
        attributes: ["originalName"],
      });
      skipped.push({
        id,
        name: asset?.originalName ?? null,
        reason: error.code === "MEDIA_IN_USE" ? "in_use" : "not_found",
      });
    }
  }
  return { archived, skipped };
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
    homepage,
    storeSettings,
    theme,
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
    // Homepage sections, the store logo and the theme keep the asset ID inside JSON.
    sequelize.query(
      "SELECT COUNT(*) AS count FROM homepage_sections WHERE deletedAt IS NULL AND JSON_SEARCH(config, 'one', :id) IS NOT NULL",
      { replacements: { id }, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      "SELECT COUNT(*) AS count FROM store_settings WHERE JSON_SEARCH(value, 'one', :id) IS NOT NULL",
      { replacements: { id }, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      "SELECT COUNT(*) AS count FROM theme_settings WHERE JSON_SEARCH(settings, 'one', :id) IS NOT NULL",
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
    homepage: Number((homepage[0] as { count?: unknown })?.count || 0),
    settings: Number((storeSettings[0] as { count?: unknown })?.count || 0),
    theme: Number((theme[0] as { count?: unknown })?.count || 0),
  };
  return {
    id,
    inUse: Object.values(usages).some((count: RuntimeValue) => count > 0),
    usages,
  };
}
