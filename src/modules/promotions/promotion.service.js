import { Op } from 'sequelize';
import { Category, CouponPhone, CouponUsage, Order, Product, User } from '../../db/models.js';
import { AppError } from '../../lib/errors.js';
import { money, moneyString } from '../../lib/money.js';

export const couponInclude = [
  { model: Product, as: 'includedProducts', attributes: ['id'], through: { attributes: [] } },
  { model: Product, as: 'excludedProducts', attributes: ['id'], through: { attributes: [] } },
  { model: Category, as: 'includedCategories', attributes: ['id'], through: { attributes: [] } },
  { model: Category, as: 'excludedCategories', attributes: ['id'], through: { attributes: [] } },
  { model: User, as: 'eligibleUsers', attributes: ['id'], through: { attributes: [] } },
  { model: CouponPhone, as: 'eligiblePhones', attributes: ['phone'] },
];

function couponError(code, message) {
  throw AppError.unprocessable(code, message, { code: [message] });
}

function basicEligibility(coupon, context) {
  const now = context.now || new Date();
  if (!coupon.active || coupon.deletedAt) couponError('COUPON_INACTIVE', 'This coupon is not active.');
  if (coupon.startsAt && coupon.startsAt > now) couponError('COUPON_NOT_STARTED', 'This coupon is not active yet.');
  if (coupon.endsAt && coupon.endsAt <= now) couponError('COUPON_EXPIRED', 'This coupon has expired.');
  if (coupon.minimumSpend != null && context.subtotal.lessThan(coupon.minimumSpend)) couponError('COUPON_MINIMUM_SPEND', `Spend at least ${moneyString(coupon.minimumSpend)} to use this coupon.`);
  if (coupon.maximumSpend != null && context.subtotal.greaterThan(coupon.maximumSpend)) couponError('COUPON_MAXIMUM_SPEND', 'This coupon is not available for the current cart total.');
  if (context.zoneCode && Array.isArray(coupon.allowedZones) && coupon.allowedZones.length && !coupon.allowedZones.includes(context.zoneCode)) couponError('COUPON_ZONE_RESTRICTED', 'This coupon is not available for the selected delivery area.');
  if (context.paymentMethod && Array.isArray(coupon.allowedPayments) && coupon.allowedPayments.length && !coupon.allowedPayments.includes(context.paymentMethod)) couponError('COUPON_PAYMENT_RESTRICTED', 'This coupon is not available for the selected payment method.');
  const eligibleUsers = new Set(coupon.eligibleUsers?.map((user) => user.id) || []);
  const eligiblePhones = new Set(coupon.eligiblePhones?.map((entry) => entry.phone) || []);
  if ((eligibleUsers.size || eligiblePhones.size) && (context.strictContext || context.userId || context.customerPhone)) {
    if ((!context.userId || !eligibleUsers.has(context.userId)) && (!context.customerPhone || !eligiblePhones.has(context.customerPhone))) couponError('COUPON_CUSTOMER_RESTRICTED', 'This coupon is not available for this customer.');
  }
}

async function usageEligibility(coupon, context, transaction) {
  const activeUsage = { couponId: coupon.id, status: { [Op.in]: ['reserved', 'consumed'] } };
  if (coupon.usageLimit != null && await CouponUsage.count({ where: activeUsage, transaction }) >= coupon.usageLimit) couponError('COUPON_USAGE_LIMIT', 'This coupon has reached its usage limit.');
  if (coupon.perCustomerLimit != null && (context.userId || context.customerPhone)) {
    const identity = context.userId ? { userId: context.userId } : { customerPhone: context.customerPhone };
    if (await CouponUsage.count({ where: { ...activeUsage, ...identity }, transaction }) >= coupon.perCustomerLimit) couponError('COUPON_CUSTOMER_LIMIT', 'You have already used this coupon the maximum number of times.');
  }
  if (coupon.firstOrderOnly && (context.userId || context.customerPhone)) {
    const identity = context.userId ? { userId: context.userId } : { customerPhone: context.customerPhone };
    if (await Order.count({ where: { ...identity, orderStatus: { [Op.notIn]: ['cancelled', 'failed', 'draft', 'pending_payment'] } }, transaction })) couponError('COUPON_FIRST_ORDER_ONLY', 'This coupon is available for first orders only.');
  }
}

function eligibleLines(coupon, lines) {
  const includedProducts = new Set(coupon.includedProducts?.map((item) => item.id) || []);
  const excludedProducts = new Set(coupon.excludedProducts?.map((item) => item.id) || []);
  const includedCategories = new Set(coupon.includedCategories?.map((item) => item.id) || []);
  const excludedCategories = new Set(coupon.excludedCategories?.map((item) => item.id) || []);
  return lines.filter((line) => {
    if (!coupon.includeSaleItems && line.onSale) return false;
    if (excludedProducts.has(line.productId) || excludedCategories.has(line.categoryId)) return false;
    if (includedProducts.size || includedCategories.size) return includedProducts.has(line.productId) || includedCategories.has(line.categoryId);
    return true;
  });
}

function allocateProportionally(amount, lines, remaining, discounts) {
  const total = lines.reduce((sum, line) => sum.plus(remaining.get(line.id)), money(0));
  if (total.isZero()) return money(0);
  let left = money(amount).lessThan(total) ? money(amount) : total;
  const intended = left;
  lines.forEach((line, index) => {
    const available = remaining.get(line.id);
    const allocation = index === lines.length - 1 ? left : money(intended.times(available).dividedBy(total)).toDecimalPlaces(2);
    const applied = allocation.lessThan(available) ? allocation : available;
    discounts.set(line.id, discounts.get(line.id).plus(applied));
    remaining.set(line.id, available.minus(applied));
    left = left.minus(applied);
  });
  return intended.minus(left);
}

export async function calculatePromotions({ coupons, lines, subtotal, deliveryTotal, userId = null, customerPhone = null, zoneCode = null, paymentMethod = null, transaction = null, strictContext = false }) {
  const ordered = [...coupons].sort((left, right) => (left.CartCoupon?.applicationOrder || 0) - (right.CartCoupon?.applicationOrder || 0) || left.code.localeCompare(right.code));
  if (ordered.length > 1 && ordered.some((coupon) => !coupon.stackable)) couponError('COUPON_NOT_STACKABLE', 'One of the selected coupons cannot be combined with another coupon.');
  const remaining = new Map(lines.map((line) => [line.id, money(line.total)]));
  const discounts = new Map(lines.map((line) => [line.id, money(0)]));
  const applied = [];
  let deliveryDiscount = money(0);
  for (const coupon of ordered) {
    const context = { now: new Date(), subtotal: money(subtotal), userId, customerPhone, zoneCode, paymentMethod, strictContext };
    basicEligibility(coupon, context);
    if (strictContext) await usageEligibility(coupon, context, transaction);
    const eligible = eligibleLines(coupon, lines);
    if (!eligible.length && coupon.type !== 'free_delivery') couponError('COUPON_NO_ELIGIBLE_ITEMS', 'No cart items are eligible for this coupon.');
    let amount = money(0);
    if (coupon.type === 'percentage') {
      for (const line of eligible) {
        const available = remaining.get(line.id);
        const lineDiscount = money(available.times(coupon.amount).dividedBy(100)).toDecimalPlaces(2);
        discounts.set(line.id, discounts.get(line.id).plus(lineDiscount));
        remaining.set(line.id, available.minus(lineDiscount));
        amount = amount.plus(lineDiscount);
      }
    } else if (coupon.type === 'fixed_cart') {
      amount = allocateProportionally(coupon.amount, eligible, remaining, discounts);
    } else if (coupon.type === 'fixed_item') {
      for (const line of eligible) {
        const applicableQuantity = Math.min(line.quantity, coupon.perItemLimit || line.quantity);
        const requested = money(coupon.amount).times(applicableQuantity);
        const available = remaining.get(line.id);
        const lineDiscount = requested.lessThan(available) ? requested : available;
        discounts.set(line.id, discounts.get(line.id).plus(lineDiscount));
        remaining.set(line.id, available.minus(lineDiscount));
        amount = amount.plus(lineDiscount);
      }
    } else if (coupon.type === 'free_delivery') {
      const stillAvailable = money(deliveryTotal).minus(deliveryDiscount);
      amount = stillAvailable;
      deliveryDiscount = deliveryDiscount.plus(stillAvailable);
    }
    if (amount.isZero()) couponError('COUPON_NO_DISCOUNT', 'This coupon does not apply a discount to the current cart.');
    applied.push({ id: coupon.id, code: coupon.code, type: coupon.type, amount: moneyString(amount) });
  }
  const itemDiscountTotal = [...discounts.values()].reduce((sum, value) => sum.plus(value), money(0));
  return {
    coupons: applied,
    lineDiscounts: Object.fromEntries([...discounts].map(([id, value]) => [id, moneyString(value)])),
    itemDiscountTotal: moneyString(itemDiscountTotal),
    deliveryDiscount: moneyString(deliveryDiscount),
    discountTotal: moneyString(itemDiscountTotal.plus(deliveryDiscount)),
  };
}
