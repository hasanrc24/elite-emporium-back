import { fn, col, Op } from 'sequelize';
import {
  Category,
  Coupon,
  CouponPhone,
  CouponUsage,
  Order,
  Product,
  ShippingZone,
  User,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { money, moneyString } from '../../lib/money.js';
import { normalizePhone } from '../../lib/normalization.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { recordAudit } from '../audits/audit.service.js';
import { addDomainEvent } from '../events/outbox.service.js';
import { couponInclude } from './promotion.service.js';

const adminCouponInclude = couponInclude;

function couponDto(coupon, usage = null) {
  return {
    id: coupon.id,
    code: coupon.code,
    type: coupon.type,
    amount: moneyString(coupon.amount),
    startsAt: coupon.startsAt,
    endsAt: coupon.endsAt,
    minimumSpend: coupon.minimumSpend == null ? null : moneyString(coupon.minimumSpend),
    maximumSpend: coupon.maximumSpend == null ? null : moneyString(coupon.maximumSpend),
    usageLimit: coupon.usageLimit == null ? null : Number(coupon.usageLimit),
    perCustomerLimit: coupon.perCustomerLimit == null ? null : Number(coupon.perCustomerLimit),
    perItemLimit: coupon.perItemLimit == null ? null : Number(coupon.perItemLimit),
    includeSaleItems: coupon.includeSaleItems,
    firstOrderOnly: coupon.firstOrderOnly,
    stackable: coupon.stackable,
    allowedZones: coupon.allowedZones || [],
    allowedPayments: coupon.allowedPayments || [],
    active: coupon.active,
    restrictions: {
      includedProductIds: (coupon.includedProducts || []).map((item) => item.id),
      excludedProductIds: (coupon.excludedProducts || []).map((item) => item.id),
      includedCategoryIds: (coupon.includedCategories || []).map((item) => item.id),
      excludedCategoryIds: (coupon.excludedCategories || []).map((item) => item.id),
      eligibleUserIds: (coupon.eligibleUsers || []).map((item) => item.id),
      eligiblePhones: (coupon.eligiblePhones || []).map((item) => item.phone),
    },
    usage,
    version: Number(coupon.version),
    archivedAt: coupon.deletedAt || null,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

function validateCouponSemantics(payload) {
  const amount = money(payload.amount);
  if (payload.type === 'percentage' && (!amount.greaterThan(0) || amount.greaterThan(100))) throw AppError.unprocessable('INVALID_COUPON_AMOUNT', 'Percentage discounts must be greater than 0 and no more than 100.');
  if (['fixed_cart', 'fixed_item'].includes(payload.type) && !amount.greaterThan(0)) throw AppError.unprocessable('INVALID_COUPON_AMOUNT', 'Fixed discounts must be greater than zero.');
  if (payload.type === 'free_delivery' && !amount.isZero()) throw AppError.unprocessable('INVALID_COUPON_AMOUNT', 'Free-delivery coupons must use amount 0.00.');
  if (payload.startsAt && payload.endsAt && new Date(payload.startsAt) >= new Date(payload.endsAt)) throw AppError.unprocessable('INVALID_COUPON_SCHEDULE', 'Coupon end time must be after its start time.');
  if (payload.minimumSpend != null && payload.maximumSpend != null && money(payload.minimumSpend).greaterThan(payload.maximumSpend)) throw AppError.unprocessable('INVALID_COUPON_SPEND_RANGE', 'Maximum spend must be greater than or equal to minimum spend.');
  const overlap = (left, right) => left.some((id) => new Set(right).has(id));
  if (overlap(payload.includedProductIds, payload.excludedProductIds)) throw AppError.unprocessable('COUPON_PRODUCT_CONFLICT', 'A product cannot be both included and excluded.');
  if (overlap(payload.includedCategoryIds, payload.excludedCategoryIds)) throw AppError.unprocessable('COUPON_CATEGORY_CONFLICT', 'A category cannot be both included and excluded.');
}

async function validateIds(model, ids, code, transaction) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  if (await model.count({ where: { id: { [Op.in]: unique } }, transaction }) !== unique.length) throw AppError.unprocessable(code, 'One or more selected restriction values do not exist.');
}

async function validateCouponReferences(payload, transaction) {
  await validateIds(Product, [...payload.includedProductIds, ...payload.excludedProductIds], 'INVALID_COUPON_PRODUCT', transaction);
  await validateIds(Category, [...payload.includedCategoryIds, ...payload.excludedCategoryIds], 'INVALID_COUPON_CATEGORY', transaction);
  await validateIds(User, payload.eligibleUserIds, 'INVALID_COUPON_CUSTOMER', transaction);
  if (payload.allowedZones.length) {
    const count = await ShippingZone.count({ where: { code: { [Op.in]: [...new Set(payload.allowedZones)] } }, transaction });
    if (count !== new Set(payload.allowedZones).size) throw AppError.unprocessable('INVALID_COUPON_ZONE', 'One or more selected shipping zones do not exist.');
  }
}

async function syncRestrictions(coupon, payload, transaction) {
  await coupon.setIncludedProducts([...new Set(payload.includedProductIds)], { transaction });
  await coupon.setExcludedProducts([...new Set(payload.excludedProductIds)], { transaction });
  await coupon.setIncludedCategories([...new Set(payload.includedCategoryIds)], { transaction });
  await coupon.setExcludedCategories([...new Set(payload.excludedCategoryIds)], { transaction });
  await coupon.setEligibleUsers([...new Set(payload.eligibleUserIds)], { transaction });
  await CouponPhone.destroy({ where: { couponId: coupon.id }, transaction });
  const phones = [...new Set(payload.eligiblePhones.map(normalizePhone))];
  if (phones.some((phone) => !phone)) throw AppError.unprocessable('INVALID_COUPON_PHONE', 'Enter valid Bangladeshi customer phone numbers.');
  if (phones.length) await CouponPhone.bulkCreate(phones.map((phone) => ({ id: newId(), couponId: coupon.id, phone })), { transaction });
}

function couponValues(payload) {
  return {
    code: payload.code.trim().toUpperCase(),
    type: payload.type,
    amount: payload.amount,
    startsAt: payload.startsAt || null,
    endsAt: payload.endsAt || null,
    minimumSpend: payload.minimumSpend || null,
    maximumSpend: payload.maximumSpend || null,
    usageLimit: payload.usageLimit ?? null,
    perCustomerLimit: payload.perCustomerLimit ?? null,
    perItemLimit: payload.perItemLimit ?? null,
    includeSaleItems: payload.includeSaleItems,
    firstOrderOnly: payload.firstOrderOnly,
    stackable: payload.stackable,
    allowedZones: payload.allowedZones,
    allowedPayments: payload.allowedPayments,
    active: payload.active,
  };
}

async function hydrateCoupon(id, transaction = null) {
  return Coupon.findByPk(id, { paranoid: false, include: adminCouponInclude, transaction });
}

export async function listCoupons(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = {};
  if (query.status === 'archived') where.deletedAt = { [Op.ne]: null };
  else if (query.status === 'active') { where.active = true; where.deletedAt = null; }
  else if (query.status === 'inactive') { where.active = false; where.deletedAt = null; }
  if (query.type) where.type = query.type;
  if (query.search) where.code = { [Op.like]: `%${String(query.search).slice(0, 80).toUpperCase()}%` };
  const result = await Coupon.findAndCountAll({ where, paranoid: false, include: adminCouponInclude, distinct: true, limit, offset, order: [['createdAt', 'DESC']] });
  const ids = result.rows.map((coupon) => coupon.id);
  const grouped = ids.length ? await CouponUsage.findAll({ where: { couponId: { [Op.in]: ids }, status: { [Op.in]: ['reserved', 'consumed'] } }, attributes: ['couponId', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('amount')), 0), 'amount']], group: ['couponId'], raw: true }) : [];
  const usage = new Map(grouped.map((row) => [row.couponId, { count: Number(row.count), amount: moneyString(row.amount) }]));
  return { data: result.rows.map((coupon) => couponDto(coupon, usage.get(coupon.id) || { count: 0, amount: '0.00' })), meta: pageEnvelope(result, page, pageSize).meta };
}

export async function getCoupon(id) {
  const coupon = await hydrateCoupon(id);
  if (!coupon) throw AppError.notFound('Coupon not found.');
  const usages = await CouponUsage.findAll({ where: { couponId: id, status: { [Op.in]: ['reserved', 'consumed'] } } });
  return couponDto(coupon, { count: usages.length, amount: moneyString(usages.reduce((sum, usage) => sum.plus(usage.amount), money(0))) });
}

export async function createCoupon(payload, actorId, request) {
  validateCouponSemantics(payload);
  return sequelize.transaction(async (transaction) => {
    await validateCouponReferences(payload, transaction);
    const coupon = await Coupon.create({ id: newId(), ...couponValues(payload), version: 1 }, { transaction });
    await syncRestrictions(coupon, payload, transaction);
    const hydrated = await hydrateCoupon(coupon.id, transaction);
    const after = couponDto(hydrated, { count: 0, amount: '0.00' });
    await recordAudit({ actorId, action: 'promotion.coupon_create', resourceType: 'coupon', resourceId: coupon.id, after, request, transaction });
    await addDomainEvent({ topic: 'promotion.coupon_updated', aggregateType: 'coupon', aggregateId: coupon.id, payload: { couponId: coupon.id, code: coupon.code, active: coupon.active }, transaction });
    return after;
  });
}

export async function updateCoupon(id, payload, actorId, request) {
  validateCouponSemantics(payload);
  return sequelize.transaction(async (transaction) => {
    const coupon = await Coupon.findByPk(id, { paranoid: false, transaction, lock: transaction.LOCK.UPDATE });
    if (!coupon) throw AppError.notFound('Coupon not found.');
    if (coupon.deletedAt) throw AppError.conflict('COUPON_ARCHIVED', 'Restore this coupon before editing it.');
    if (Number(payload.version) !== Number(coupon.version)) throw AppError.conflict('VERSION_CONFLICT', 'This coupon changed. Refresh and review the latest version.');
    await validateCouponReferences(payload, transaction);
    const before = couponDto(await hydrateCoupon(id, transaction));
    await coupon.update({ ...couponValues(payload), version: coupon.version + 1 }, { transaction });
    await syncRestrictions(coupon, payload, transaction);
    const after = couponDto(await hydrateCoupon(id, transaction));
    await recordAudit({ actorId, action: 'promotion.coupon_update', resourceType: 'coupon', resourceId: coupon.id, before, after, request, transaction });
    await addDomainEvent({ topic: 'promotion.coupon_updated', aggregateType: 'coupon', aggregateId: coupon.id, payload: { couponId: coupon.id, code: coupon.code, active: coupon.active }, transaction });
    return after;
  });
}

export async function setCouponActive(id, payload, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const coupon = await Coupon.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!coupon) throw AppError.notFound('Coupon not found.');
    if (Number(payload.version) !== Number(coupon.version)) throw AppError.conflict('VERSION_CONFLICT', 'This coupon changed. Refresh and review the latest version.');
    const before = { active: coupon.active, version: Number(coupon.version) };
    coupon.active = payload.active;
    coupon.version += 1;
    await coupon.save({ transaction });
    await recordAudit({ actorId, action: payload.active ? 'promotion.coupon_activate' : 'promotion.coupon_deactivate', resourceType: 'coupon', resourceId: coupon.id, before, after: { active: coupon.active, version: coupon.version }, request, transaction });
    return couponDto(await hydrateCoupon(id, transaction));
  });
}

export async function archiveCoupon(id, version, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const coupon = await Coupon.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!coupon) throw AppError.notFound('Coupon not found.');
    if (Number(version) !== Number(coupon.version)) throw AppError.conflict('VERSION_CONFLICT', 'This coupon changed. Refresh and review the latest version.');
    coupon.active = false;
    coupon.version += 1;
    await coupon.save({ transaction });
    await coupon.destroy({ transaction });
    await recordAudit({ actorId, action: 'promotion.coupon_archive', resourceType: 'coupon', resourceId: coupon.id, after: { archived: true }, request, transaction });
  });
}

export async function restoreCoupon(id, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const coupon = await Coupon.findByPk(id, { paranoid: false, transaction, lock: transaction.LOCK.UPDATE });
    if (!coupon || !coupon.deletedAt) throw AppError.notFound('Archived coupon not found.');
    await coupon.restore({ transaction });
    coupon.active = false;
    coupon.version += 1;
    await coupon.save({ transaction });
    await recordAudit({ actorId, action: 'promotion.coupon_restore', resourceType: 'coupon', resourceId: coupon.id, after: { active: false, version: coupon.version }, request, transaction });
    return couponDto(await hydrateCoupon(id, transaction));
  });
}

export async function duplicateCoupon(id, code, actorId, request) {
  const source = await hydrateCoupon(id);
  if (!source) throw AppError.notFound('Coupon not found.');
  const dto = couponDto(source);
  return createCoupon({
    code,
    type: dto.type,
    amount: dto.amount,
    startsAt: null,
    endsAt: null,
    minimumSpend: dto.minimumSpend,
    maximumSpend: dto.maximumSpend,
    usageLimit: dto.usageLimit,
    perCustomerLimit: dto.perCustomerLimit,
    perItemLimit: dto.perItemLimit,
    includeSaleItems: dto.includeSaleItems,
    firstOrderOnly: dto.firstOrderOnly,
    stackable: dto.stackable,
    allowedZones: dto.allowedZones,
    allowedPayments: dto.allowedPayments,
    active: false,
    ...dto.restrictions,
  }, actorId, request);
}

export async function listCouponUsage(id, query) {
  if (!await Coupon.count({ where: { id }, paranoid: false })) throw AppError.notFound('Coupon not found.');
  const { page, pageSize, limit, offset } = pagination(query);
  const where = { couponId: id };
  if (query.status) where.status = query.status;
  const result = await CouponUsage.findAndCountAll({ where, include: [{ model: Order, as: 'order', attributes: ['id', 'reference', 'customerName', 'customerPhone'] }, { model: User, as: 'user', attributes: ['id', 'name', 'phone', 'email'] }], limit, offset, order: [['createdAt', 'DESC']] });
  return { data: result.rows.map((usage) => ({ id: usage.id, order: usage.order, user: usage.user, customerPhone: usage.customerPhone, amount: moneyString(usage.amount), status: usage.status, createdAt: usage.createdAt, updatedAt: usage.updatedAt })), meta: pageEnvelope(result, page, pageSize).meta };
}

export { couponDto, validateCouponSemantics };

