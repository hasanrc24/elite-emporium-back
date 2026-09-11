import sanitizeHtml from "sanitize-html";
import { fn, col, Op } from "sequelize";
import {
  MediaAsset,
  Order,
  OrderItem,
  Product,
  ProductVariant,
  Review,
  User,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { mediaPublicUrl } from "../media/media.storage.js";

function cleanText(value: RuntimeValue, maximum: RuntimeValue) {
  return sanitizeHtml(String(value || ""), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .trim()
    .slice(0, maximum);
}

const reviewInclude: RuntimeValue = [
  { model: User, as: "user", attributes: ["id", "name"] },
  {
    model: MediaAsset,
    as: "media",
    through: { attributes: ["displayOrder"] },
    required: false,
  },
];

function reviewDto(review: RuntimeValue, admin: RuntimeValue = false) {
  return {
    id: review.id,
    productId: review.productId,
    orderItemId: admin ? review.orderItemId : undefined,
    rating: review.rating,
    title: review.title,
    body: review.body,
    verifiedPurchase: review.verifiedPurchase,
    status: admin ? review.status : undefined,
    moderationReason: admin ? review.moderationReason : undefined,
    staffResponse: review.staffResponse || null,
    customer: review.user
      ? {
          name: `${String(review.user.name).split(/\s+/)[0]}${String(review.user.name).includes(" ") ? " …" : ""}`,
        }
      : null,
    media: (review.media || [])
      .filter(
        (asset: RuntimeValue) =>
          asset.privacy === "public" && asset.status === "ready",
      )
      .map((asset: RuntimeValue) => ({
        id: asset.id,
        url: mediaPublicUrl(asset.storageKey),
        alt: asset.altText || "",
      })),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    version: admin ? review.version : undefined,
  };
}

async function recalculateProductReviews(
  productId: RuntimeValue,
  transaction: RuntimeValue = null,
) {
  const aggregate: RuntimeValue = await Review.findOne({
    attributes: [
      [fn("COUNT", col("id")), "count"],
      [fn("COALESCE", fn("AVG", col("rating")), 0), "average"],
    ],
    where: { productId, status: "approved" },
    raw: true,
    transaction,
  });
  await Product.update(
    {
      reviewCount: Number(aggregate.count || 0),
      reviewAverage: Number(aggregate.average || 0).toFixed(2),
    },
    { where: { id: productId }, transaction },
  );
}

export async function listPublicReviews(
  productId: RuntimeValue,
  query: RuntimeValue,
) {
  const product: RuntimeValue = await Product.findOne({
    where: { id: productId, status: "published" },
    attributes: ["id", "reviewAverage", "reviewCount"],
  });
  if (!product) throw AppError.notFound("Product not found.");
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const result: RuntimeValue = await Review.findAndCountAll({
    where: { productId, status: "approved" },
    include: reviewInclude,
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((review: RuntimeValue) => reviewDto(review)),
    meta: {
      ...pageEnvelope(result, page, pageSize).meta,
      aggregate: {
        average: Number(product.reviewAverage),
        count: Number(product.reviewCount),
      },
    },
  };
}

export async function listOwnReviews(
  userId: RuntimeValue,
  query: RuntimeValue,
) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const result: RuntimeValue = await Review.findAndCountAll({
    where: { userId },
    paranoid: false,
    include: [
      ...reviewInclude,
      { model: Product, as: "product", attributes: ["id", "slug"] },
    ],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => ({
      ...reviewDto(row, true),
      product: row.product,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

async function validateReviewMedia(
  mediaIds: RuntimeValue,
  userId: RuntimeValue,
  transaction: RuntimeValue,
) {
  if (!mediaIds?.length) return [];
  const ids: RuntimeValue = [...new Set(mediaIds)];
  const rows: RuntimeValue = await MediaAsset.findAll({
    where: {
      id: { [Op.in]: ids },
      uploaderId: userId,
      kind: "image",
      privacy: "public",
      status: "ready",
    },
    transaction,
  });
  if (
    rows.length !== ids.length ||
    rows.some((row: RuntimeValue) => row.metadata?.purpose !== "review")
  )
    throw AppError.unprocessable(
      "INVALID_REVIEW_MEDIA",
      "Every review image must be uploaded by you for this review.",
    );
  return rows;
}

export async function createReview(
  userId: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const orderItem: RuntimeValue = await OrderItem.findOne({
      where: { id: payload.orderItemId, fulfilledQuantity: { [Op.gt]: 0 } },
      include: [
        {
          model: Order,
          as: "order",
          where: {
            userId,
            fulfillmentStatus: {
              [Op.in]: ["delivered", "partially_returned", "returned"],
            },
          },
        },
        {
          model: ProductVariant,
          as: "variant",
          paranoid: false,
          where: { productId: payload.productId },
        },
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !orderItem ||
      Number(orderItem.returnedQuantity) >= Number(orderItem.fulfilledQuantity)
    )
      throw AppError.unprocessable(
        "REVIEW_NOT_ELIGIBLE",
        "Only fulfilled, retained order items can be reviewed.",
      );
    if (
      await Review.findOne({
        where: { orderItemId: orderItem.id },
        paranoid: false,
        transaction,
      })
    )
      throw AppError.conflict(
        "REVIEW_ALREADY_EXISTS",
        "This order item has already been reviewed.",
      );
    const media: RuntimeValue = await validateReviewMedia(
      payload.mediaIds,
      userId,
      transaction,
    );
    const title: RuntimeValue = cleanText(payload.title, 180);
    const body: RuntimeValue = cleanText(payload.body, 5000);
    if (!body)
      throw AppError.unprocessable(
        "REVIEW_BODY_REQUIRED",
        "Write a review before submitting.",
      );
    const review: RuntimeValue = await Review.create(
      {
        id: newId(),
        productId: payload.productId,
        userId,
        orderItemId: orderItem.id,
        rating: payload.rating,
        title: title || null,
        body,
        status: "pending",
        verifiedPurchase: true,
        version: 1,
      },
      { transaction },
    );
    if (media.length) await review.setMedia(media, { transaction });
    await recordAudit({
      actorId: userId,
      action: "review.create",
      resourceType: "review",
      resourceId: review.id,
      after: { productId: payload.productId, rating: payload.rating },
      request,
      transaction,
    });
    return reviewDto(
      await Review.findByPk(review.id, { include: reviewInclude, transaction }),
      true,
    );
  });
}

export async function updateReview(
  userId: RuntimeValue,
  id: RuntimeValue,
  payload: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const review: RuntimeValue = await Review.findOne({
      where: { id, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!review) throw AppError.notFound("Review not found.");
    if (!["pending", "rejected"].includes(review.status))
      throw AppError.conflict(
        "REVIEW_LOCKED",
        "An approved review cannot be edited.",
      );
    if (Number(payload.version) !== Number(review.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This review changed. Refresh and try again.",
      );
    const media: RuntimeValue = await validateReviewMedia(
      payload.mediaIds,
      userId,
      transaction,
    );
    const before: RuntimeValue = review.toJSON();
    review.rating = payload.rating;
    review.title = cleanText(payload.title, 180) || null;
    review.body = cleanText(payload.body, 5000);
    review.status = "pending";
    review.moderationReason = null;
    review.version += 1;
    await review.save({ transaction });
    await review.setMedia(media, { transaction });
    await recordAudit({
      actorId: userId,
      action: "review.update",
      resourceType: "review",
      resourceId: review.id,
      before,
      after: review.toJSON(),
      request,
      transaction,
    });
    return reviewDto(
      await Review.findByPk(review.id, { include: reviewInclude, transaction }),
      true,
    );
  });
}

export async function deleteReview(
  userId: RuntimeValue,
  id: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const review: RuntimeValue = await Review.findOne({
      where: { id, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!review) throw AppError.notFound("Review not found.");
    const productId = review.productId;
    await review.destroy({ transaction });
    if (review.status === "approved")
      await recalculateProductReviews(productId, transaction);
    await recordAudit({
      actorId: userId,
      action: "review.delete",
      resourceType: "review",
      resourceId: id,
      request,
      transaction,
    });
  });
}

export async function listAdminReviews(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.rating) where.rating = Number(query.rating);
  if (query.productId) where.productId = query.productId;
  const result: RuntimeValue = await Review.findAndCountAll({
    where,
    paranoid: false,
    include: [
      ...reviewInclude,
      { model: Product, as: "product", attributes: ["id", "slug"] },
    ],
    distinct: true,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => ({
      ...reviewDto(row, true),
      product: row.product,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function moderateReview(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const review: RuntimeValue = await Review.findByPk(id, {
      paranoid: false,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!review) throw AppError.notFound("Review not found.");
    if (Number(payload.version) !== Number(review.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This review changed. Refresh and try again.",
      );
    const before: RuntimeValue = {
      status: review.status,
      reason: review.moderationReason,
    };
    review.status = payload.status;
    review.moderationReason = payload.reason;
    review.moderatedBy = actorId;
    review.moderatedAt = new Date();
    review.version += 1;
    await review.save({ transaction });
    await recalculateProductReviews(review.productId, transaction);
    await addDomainEvent({
      topic: `review.${payload.status}`,
      aggregateType: "review",
      aggregateId: review.id,
      payload: {
        reviewId: review.id,
        productId: review.productId,
        status: payload.status,
      },
      transaction,
    });
    await recordAudit({
      actorId,
      action: "review.moderate",
      resourceType: "review",
      resourceId: review.id,
      before,
      after: { status: review.status, reason: review.moderationReason },
      request,
      transaction,
    });
    return reviewDto(
      await Review.findByPk(review.id, { include: reviewInclude, transaction }),
      true,
    );
  });
}

export async function respondToReview(
  id: RuntimeValue,
  response: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const review: RuntimeValue = await Review.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!review) throw AppError.notFound("Review not found.");
    if (review.status !== "approved")
      throw AppError.conflict(
        "REVIEW_NOT_PUBLIC",
        "Only an approved review can receive a public response.",
      );
    review.staffResponse = cleanText(response, 2000);
    review.respondedAt = new Date();
    review.version += 1;
    await review.save({ transaction });
    await recordAudit({
      actorId,
      action: "review.respond",
      resourceType: "review",
      resourceId: review.id,
      request,
      transaction,
    });
    return reviewDto(
      await Review.findByPk(review.id, { include: reviewInclude, transaction }),
      true,
    );
  });
}
