import { col, fn, Op } from "sequelize";
import {
  AuthSession,
  CustomerNote,
  Order,
  OrderItem,
  Payment,
  PrivacyRequest,
  Product,
  ReturnRequest,
  Review,
  Role,
  User,
  UserAddress,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { normalizeEmail, normalizePhone } from "../../lib/normalization.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { queueNotification } from "../events/outbox.service.js";
import { orderDto } from "../orders/order.service.js";
import { returnDetailInclude, returnDto } from "../returns/return.presenter.js";

const customerRoleInclude: RuntimeValue = {
  model: Role,
  as: "roles",
  where: { key: "customer" },
  attributes: ["id", "key", "name"],
  through: { attributes: [] },
  required: true,
};

function customerDto(user: RuntimeValue, stats: RuntimeValue = {}) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    locale: user.locale,
    status: user.status,
    riskLevel: user.riskLevel,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    emailVerified: Boolean(user.emailVerifiedAt),
    version: Number(user.version),
    lastLoginAt: user.lastLoginAt,
    deletedAt: user.deletedAt || null,
    stats: {
      orderCount: Number(stats.orderCount || 0),
      grossPaid: moneyString(stats.grossPaid || 0),
      returnCount: Number(stats.returnCount || 0),
      reviewCount: Number(stats.reviewCount || 0),
      lastOrderAt: stats.lastOrderAt || null,
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function mapAggregates(rows: RuntimeValue) {
  return new Map(rows.map((row: RuntimeValue) => [row.userId, row]));
}

async function customerStats(userIds: RuntimeValue) {
  if (!userIds.length) return new Map();
  const [orders, paid, returns, reviews]: RuntimeValue = await Promise.all([
    Order.findAll({
      attributes: [
        "userId",
        [fn("COUNT", col("id")), "orderCount"],
        [fn("MAX", col("createdAt")), "lastOrderAt"],
      ],
      where: { userId: { [Op.in]: userIds } },
      group: ["userId"],
      raw: true,
    }),
    Order.findAll({
      attributes: [
        "userId",
        [fn("COALESCE", fn("SUM", col("grandTotal")), 0), "grossPaid"],
      ],
      where: {
        userId: { [Op.in]: userIds },
        paymentStatus: { [Op.in]: ["paid", "partially_refunded", "refunded"] },
      },
      group: ["userId"],
      raw: true,
    }),
    ReturnRequest.findAll({
      attributes: ["userId", [fn("COUNT", col("id")), "returnCount"]],
      where: { userId: { [Op.in]: userIds } },
      group: ["userId"],
      raw: true,
    }),
    Review.findAll({
      attributes: ["userId", [fn("COUNT", col("id")), "reviewCount"]],
      where: { userId: { [Op.in]: userIds } },
      group: ["userId"],
      raw: true,
      paranoid: false,
    }),
  ]);
  const maps: RuntimeValue = [orders, paid, returns, reviews].map(
    mapAggregates,
  );
  return new Map(
    userIds.map((userId: RuntimeValue) => [
      userId,
      Object.assign(
        {},
        ...maps.map((map: RuntimeValue) => map.get(userId) || {}),
      ),
    ]),
  );
}

function customerLifecycle(query: RuntimeValue, where: RuntimeValue) {
  if (query.lifecycle === "deleted") {
    where.deletedAt = { [Op.ne]: null };
    return false;
  }
  return query.lifecycle !== "all";
}

export async function listCustomers(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.status) where.status = query.status;
  if (query.riskLevel) where.riskLevel = query.riskLevel;
  if (query.locale) where.locale = query.locale;
  if (query.search) {
    const search: RuntimeValue = String(query.search).trim().slice(0, 120);
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
    ];
  }
  if (query.createdFrom || query.createdTo)
    where.createdAt = {
      ...(query.createdFrom ? { [Op.gte]: new Date(query.createdFrom) } : {}),
      ...(query.createdTo ? { [Op.lt]: new Date(query.createdTo) } : {}),
    };
  const paranoid: RuntimeValue = customerLifecycle(query, where);
  const sort: RuntimeValue = (
    {
      created_asc: [["createdAt", "ASC"]],
      name_asc: [
        ["name", "ASC"],
        ["id", "ASC"],
      ],
      name_desc: [
        ["name", "DESC"],
        ["id", "DESC"],
      ],
      last_login: [
        ["lastLoginAt", "DESC"],
        ["id", "DESC"],
      ],
    } as RuntimeValue
  )[query.sort] || [["createdAt", "DESC"]];
  const result: RuntimeValue = await User.findAndCountAll({
    where,
    paranoid,
    include: [customerRoleInclude],
    distinct: true,
    limit,
    offset,
    order: sort,
  });
  const stats: RuntimeValue = await customerStats(
    result.rows.map((user: RuntimeValue) => user.id),
  );
  return {
    data: result.rows.map((user: RuntimeValue) =>
      customerDto(user, stats.get(user.id)),
    ),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

async function findCustomer(
  id: RuntimeValue,
  { transaction = null, lock = null }: RuntimeValue = {},
) {
  const user: RuntimeValue = await User.findOne({
    where: { id },
    paranoid: false,
    include: [customerRoleInclude],
    transaction,
    ...(lock ? { lock } : {}),
  });
  if (!user) throw AppError.notFound("Customer not found.");
  return user;
}

function noteDto(note: RuntimeValue) {
  return {
    id: note.id,
    category: note.category,
    message: note.message,
    actor: note.actor ? { id: note.actor.id, name: note.actor.name } : null,
    createdAt: note.createdAt,
  };
}

function privacyDto(row: RuntimeValue) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    reason: row.reason,
    metadata: row.metadata,
    version: Number(row.version),
    requestedAt: row.requestedAt,
    reviewedAt: row.reviewedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCustomer(id: RuntimeValue) {
  const user: RuntimeValue = await findCustomer(id);
  const [
    stats,
    addresses,
    orders,
    returns,
    reviews,
    notes,
    privacyRequests,
    activeSessions,
  ]: RuntimeValue = await Promise.all([
    customerStats([id]),
    UserAddress.findAll({
      where: { userId: id },
      paranoid: false,
      order: [["createdAt", "DESC"]],
    }),
    Order.findAll({
      where: { userId: id },
      include: [
        { model: OrderItem, as: "items" },
        { model: Payment, as: "payments" },
      ],
      limit: 25,
      order: [["createdAt", "DESC"]],
    }),
    ReturnRequest.findAll({
      where: { userId: id },
      include: returnDetailInclude,
      limit: 25,
      order: [["createdAt", "DESC"]],
    }),
    Review.findAll({
      where: { userId: id },
      paranoid: false,
      include: [{ model: Product, as: "product", attributes: ["id", "slug"] }],
      limit: 25,
      order: [["createdAt", "DESC"]],
    }),
    CustomerNote.findAll({
      where: { userId: id },
      include: [
        {
          model: User,
          as: "actor",
          attributes: ["id", "name"],
          paranoid: false,
        },
      ],
      limit: 100,
      order: [["createdAt", "DESC"]],
    }),
    PrivacyRequest.findAll({
      where: { userId: id },
      order: [["createdAt", "DESC"]],
    }),
    AuthSession.count({
      where: {
        userId: id,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
    }),
  ]);
  return {
    ...customerDto(user, stats.get(id)),
    activeSessions,
    addresses: addresses.map((address: RuntimeValue) => ({
      id: address.id,
      label: address.label,
      recipientName: address.recipientName,
      phone: address.phone,
      addressLine: address.addressLine,
      area: address.area,
      district: address.district,
      division: address.division,
      postcode: address.postcode,
      landmark: address.landmark,
      defaultShipping: address.isDefaultShipping,
      defaultBilling: address.isDefaultBilling,
      deletedAt: address.deletedAt,
      version: Number(address.version),
    })),
    recentOrders: orders.map((order: RuntimeValue) => orderDto(order, true)),
    recentReturns: returns.map((row: RuntimeValue) =>
      returnDto(row, { internal: true }),
    ),
    recentReviews: reviews.map((review: RuntimeValue) => ({
      id: review.id,
      product: review.product,
      rating: Number(review.rating),
      title: review.title,
      body: review.body,
      status: review.status,
      verifiedPurchase: Boolean(review.verifiedPurchase),
      moderationReason: review.moderationReason,
      version: Number(review.version),
      deletedAt: review.deletedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    })),
    notes: notes.map(noteDto),
    privacyRequests: privacyRequests.map(privacyDto),
  };
}

export async function updateCustomer(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const user: RuntimeValue = await findCustomer(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (user.deletedAt)
      throw AppError.conflict(
        "CUSTOMER_DELETED",
        "A deleted customer account cannot be edited.",
      );
    if (Number(payload.version) !== Number(user.version))
      throw AppError.conflict(
        "VERSION_CONFLICT",
        "This customer changed. Refresh and review the latest version.",
      );
    const phone: RuntimeValue =
      payload.phone === undefined ? user.phone : normalizePhone(payload.phone);
    const email: RuntimeValue =
      payload.email === undefined ? user.email : normalizeEmail(payload.email);
    if (payload.phone && !phone)
      throw AppError.unprocessable(
        "INVALID_PHONE",
        "Enter a valid Bangladeshi phone number.",
      );
    if (!phone && !email)
      throw AppError.unprocessable(
        "IDENTIFIER_REQUIRED",
        "A customer account must keep a phone number or email.",
      );
    const identityChanged = phone !== user.phone || email !== user.email;
    if (identityChanged) {
      const duplicate: RuntimeValue = await User.findOne({
        where: {
          id: { [Op.ne]: user.id },
          [Op.or]: [phone && { phone }, email && { email }].filter(Boolean),
        },
        paranoid: false,
        transaction,
      });
      if (duplicate)
        throw AppError.conflict(
          "IDENTIFIER_IN_USE",
          "That phone number or email is already assigned to another account.",
        );
    }
    const before: RuntimeValue = {
      name: user.name,
      phone: user.phone,
      email: user.email,
      locale: user.locale,
      status: user.status,
      riskLevel: user.riskLevel,
      version: Number(user.version),
    };
    if (payload.name !== undefined) user.name = payload.name;
    if (payload.locale !== undefined) user.locale = payload.locale;
    if (phone !== user.phone) {
      user.phone = phone;
      user.phoneVerifiedAt = null;
    }
    if (email !== user.email) {
      user.email = email;
      user.emailVerifiedAt = null;
    }
    if (payload.status !== undefined) user.status = payload.status;
    if (payload.riskLevel !== undefined) user.riskLevel = payload.riskLevel;
    const accessRestricted =
      user.status === "disabled" || user.riskLevel === "blocked";
    const securityStateChanged =
      before.status !== user.status ||
      before.riskLevel !== user.riskLevel ||
      identityChanged;
    if (securityStateChanged) user.roleVersion += 1;
    user.version += 1;
    await user.save({ transaction });
    if (securityStateChanged)
      await AuthSession.update(
        {
          revokedAt: new Date(),
          revokeReason: accessRestricted
            ? "customer_access_restricted"
            : "customer_profile_changed_by_admin",
        },
        { where: { userId: user.id, revokedAt: null }, transaction },
      );
    const recipient = user.email || user.phone;
    if (securityStateChanged && recipient && payload.customerMessage)
      await queueNotification({
        event: "account.admin_update",
        channel: user.email ? "email" : "sms",
        locale: user.locale,
        recipient,
        payload: { name: user.name, message: payload.customerMessage },
        transaction,
      });
    const after: RuntimeValue = {
      name: user.name,
      phone: user.phone,
      email: user.email,
      locale: user.locale,
      status: user.status,
      riskLevel: user.riskLevel,
      version: Number(user.version),
    };
    await recordAudit({
      actorId,
      action: "customer.update",
      resourceType: "user",
      resourceId: user.id,
      before,
      after,
      metadata: {
        reason: payload.reason,
        sessionsRevoked: securityStateChanged,
      },
      request,
      transaction,
    });
    return customerDto(await findCustomer(user.id, { transaction }));
  });
}

export async function addCustomerNote(
  id: RuntimeValue,
  payload: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    await findCustomer(id, { transaction });
    const note: RuntimeValue = await CustomerNote.create(
      {
        id: newId(),
        userId: id,
        actorId,
        category: payload.category,
        message: payload.message,
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "customer.note_add",
      resourceType: "user",
      resourceId: id,
      metadata: { noteId: note.id, category: note.category },
      request,
      transaction,
    });
    return noteDto(
      await CustomerNote.findByPk(note.id, {
        include: [
          {
            model: User,
            as: "actor",
            attributes: ["id", "name"],
            paranoid: false,
          },
        ],
        transaction,
      }),
    );
  });
}
