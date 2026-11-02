import { Op } from "sequelize";
import {
  Category,
  CouponPhone,
  CouponUsage,
  Order,
  Product,
  User,
} from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { money, moneyString } from "../../lib/money.js";

export const couponInclude: RuntimeValue = [
  {
    model: Product,
    as: "includedProducts",
    attributes: ["id"],
    through: { attributes: [] },
  },
  {
    model: Product,
    as: "excludedProducts",
    attributes: ["id"],
    through: { attributes: [] },
  },
  {
    model: Category,
    as: "includedCategories",
    attributes: ["id"],
    through: { attributes: [] },
  },
  {
    model: Category,
    as: "excludedCategories",
    attributes: ["id"],
    through: { attributes: [] },
  },
  {
    model: User,
    as: "eligibleUsers",
    attributes: ["id"],
    through: { attributes: [] },
  },
  { model: CouponPhone, as: "eligiblePhones", attributes: ["phone"] },
];

function couponError(code: RuntimeValue, message: RuntimeValue) {
  throw AppError.unprocessable(code, message, { code: [message] });
}

function basicEligibility(coupon: RuntimeValue, context: RuntimeValue) {
  const now = context.now || new Date();
  if (!coupon.active || coupon.deletedAt)
    couponError("COUPON_INACTIVE", "This coupon is not active.");
  if (coupon.startsAt && coupon.startsAt > now)
    couponError("COUPON_NOT_STARTED", "This coupon is not active yet.");
  if (coupon.endsAt && coupon.endsAt <= now)
    couponError("COUPON_EXPIRED", "This coupon has expired.");
  if (
    coupon.minimumSpend != null &&
    context.subtotal.lessThan(coupon.minimumSpend)
  )
    couponError(
      "COUPON_MINIMUM_SPEND",
      `Spend at least ${moneyString(coupon.minimumSpend)} to use this coupon.`,
    );
  if (
    coupon.maximumSpend != null &&
    context.subtotal.greaterThan(coupon.maximumSpend)
  )
    couponError(
      "COUPON_MAXIMUM_SPEND",
      "This coupon is not available for the current cart total.",
    );
  if (
    context.zoneCode &&
    Array.isArray(coupon.allowedZones) &&
    coupon.allowedZones.length &&
    !coupon.allowedZones.includes(context.zoneCode)
  )
    couponError(
      "COUPON_ZONE_RESTRICTED",
      "This coupon is not available for the selected delivery area.",
    );
  if (
    context.paymentMethod &&
    Array.isArray(coupon.allowedPayments) &&
    coupon.allowedPayments.length &&
    !coupon.allowedPayments.includes(context.paymentMethod)
  )
    couponError(
      "COUPON_PAYMENT_RESTRICTED",
      "This coupon is not available for the selected payment method.",
    );
  const eligibleUsers = new Set(
    coupon.eligibleUsers?.map((user: RuntimeValue) => user.id) || [],
  );
  const eligiblePhones = new Set(
    coupon.eligiblePhones?.map((entry: RuntimeValue) => entry.phone) || [],
  );
  if (
    (eligibleUsers.size || eligiblePhones.size) &&
    (context.strictContext || context.userId || context.customerPhone)
  ) {
    if (
      (!context.userId || !eligibleUsers.has(context.userId)) &&
      (!context.customerPhone || !eligiblePhones.has(context.customerPhone))
    )
      couponError(
        "COUPON_CUSTOMER_RESTRICTED",
        "This coupon is not available for this customer.",
      );
  }
}

async function usageEligibility(
  coupon: RuntimeValue,
  context: RuntimeValue,
  transaction: RuntimeValue,
) {
  const activeUsage: RuntimeValue = {
    couponId: coupon.id,
    status: { [Op.in]: ["reserved", "consumed"] },
  };
  if (
    coupon.usageLimit != null &&
    (await CouponUsage.count({ where: activeUsage, transaction })) >=
      coupon.usageLimit
  )
    couponError(
      "COUPON_USAGE_LIMIT",
      "This coupon has reached its usage limit.",
    );
  if (
    coupon.perCustomerLimit != null &&
    (context.userId || context.customerPhone)
  ) {
    const identity = context.userId
      ? { userId: context.userId }
      : { customerPhone: context.customerPhone };
    if (
      (await CouponUsage.count({
        where: { ...activeUsage, ...identity },
        transaction,
      })) >= coupon.perCustomerLimit
    )
      couponError(
        "COUPON_CUSTOMER_LIMIT",
        "You have already used this coupon the maximum number of times.",
      );
  }
  if (coupon.firstOrderOnly && (context.userId || context.customerPhone)) {
    const identity = context.userId
      ? { userId: context.userId }
      : { customerPhone: context.customerPhone };
    if (
      await Order.count({
        where: {
          ...identity,
          orderStatus: {
            [Op.notIn]: ["cancelled", "failed", "draft", "pending_payment"],
          },
        },
        transaction,
      })
    )
      couponError(
        "COUPON_FIRST_ORDER_ONLY",
        "This coupon is available for first orders only.",
      );
  }
}

function eligibleLines(coupon: RuntimeValue, lines: RuntimeValue) {
  const includedProducts = new Set(
    coupon.includedProducts?.map((item: RuntimeValue) => item.id) || [],
  );
  const excludedProducts = new Set(
    coupon.excludedProducts?.map((item: RuntimeValue) => item.id) || [],
  );
  const includedCategories = new Set(
    coupon.includedCategories?.map((item: RuntimeValue) => item.id) || [],
  );
  const excludedCategories = new Set(
    coupon.excludedCategories?.map((item: RuntimeValue) => item.id) || [],
  );
  return lines.filter((line: RuntimeValue) => {
    if (!coupon.includeSaleItems && line.onSale) return false;
    if (
      excludedProducts.has(line.productId) ||
      excludedCategories.has(line.categoryId)
    )
      return false;
    if (includedProducts.size || includedCategories.size)
      return (
        includedProducts.has(line.productId) ||
        includedCategories.has(line.categoryId)
      );
    return true;
  });
}

function allocateProportionally(
  amount: RuntimeValue,
  lines: RuntimeValue,
  remaining: RuntimeValue,
  discounts: RuntimeValue,
) {
  const total: RuntimeValue = lines.reduce(
    (sum: RuntimeValue, line: RuntimeValue) => sum.plus(remaining.get(line.id)),
    money(0),
  );
  if (total.isZero()) return money(0);
  let left: RuntimeValue = money(amount).lessThan(total)
    ? money(amount)
    : total;
  const intended = left;
  lines.forEach((line: RuntimeValue, index: RuntimeValue) => {
    const available: RuntimeValue = remaining.get(line.id);
    const allocation: RuntimeValue =
      index === lines.length - 1
        ? left
        : money(intended.times(available).dividedBy(total)).toDecimalPlaces(2);
    // Never allocate more than is still available on the line or left of the
    // coupon amount: rounding earlier shares up could otherwise leave `left`
    // negative and give the last line a negative discount.
    const capped = allocation.lessThan(left) ? allocation : left;
    const applied = capped.lessThan(available) ? capped : available;
    discounts.set(line.id, discounts.get(line.id).plus(applied));
    remaining.set(line.id, available.minus(applied));
    left = left.minus(applied);
  });
  return intended.minus(left);
}

export async function calculatePromotions({
  coupons,
  lines,
  subtotal,
  deliveryTotal,
  userId = null,
  customerPhone = null,
  zoneCode = null,
  paymentMethod = null,
  transaction = null,
  strictContext = false,
}: RuntimeValue) {
  const ordered: RuntimeValue = [...coupons].sort(
    (left: RuntimeValue, right: RuntimeValue) =>
      (left.CartCoupon?.applicationOrder || 0) -
        (right.CartCoupon?.applicationOrder || 0) ||
      left.code.localeCompare(right.code),
  );
  if (
    ordered.length > 1 &&
    ordered.some((coupon: RuntimeValue) => !coupon.stackable)
  )
    couponError(
      "COUPON_NOT_STACKABLE",
      "One of the selected coupons cannot be combined with another coupon.",
    );
  const remaining: RuntimeValue = new Map(
    lines.map((line: RuntimeValue) => [line.id, money(line.total)]),
  );
  const discounts: RuntimeValue = new Map(
    lines.map((line: RuntimeValue) => [line.id, money(0)]),
  );
  const applied: RuntimeValue = [];
  let deliveryDiscount: RuntimeValue = money(0);
  for (const coupon of ordered) {
    const context: RuntimeValue = {
      now: new Date(),
      subtotal: money(subtotal),
      userId,
      customerPhone,
      zoneCode,
      paymentMethod,
      strictContext,
    };
    basicEligibility(coupon, context);
    if (strictContext) await usageEligibility(coupon, context, transaction);
    const eligible: RuntimeValue = eligibleLines(coupon, lines);
    if (!eligible.length && coupon.type !== "free_delivery")
      couponError(
        "COUPON_NO_ELIGIBLE_ITEMS",
        "No cart items are eligible for this coupon.",
      );
    let amount: RuntimeValue = money(0);
    if (coupon.type === "percentage") {
      for (const line of eligible) {
        const available: RuntimeValue = remaining.get(line.id);
        const lineDiscount: RuntimeValue = money(
          available.times(coupon.amount).dividedBy(100),
        ).toDecimalPlaces(2);
        discounts.set(line.id, discounts.get(line.id).plus(lineDiscount));
        remaining.set(line.id, available.minus(lineDiscount));
        amount = amount.plus(lineDiscount);
      }
    } else if (coupon.type === "fixed_cart") {
      amount = allocateProportionally(
        coupon.amount,
        eligible,
        remaining,
        discounts,
      );
    } else if (coupon.type === "fixed_item") {
      for (const line of eligible) {
        const applicableQuantity: RuntimeValue = Math.min(
          line.quantity,
          coupon.perItemLimit || line.quantity,
        );
        const requested: RuntimeValue = money(coupon.amount).times(
          applicableQuantity,
        );
        const available: RuntimeValue = remaining.get(line.id);
        const lineDiscount = requested.lessThan(available)
          ? requested
          : available;
        discounts.set(line.id, discounts.get(line.id).plus(lineDiscount));
        remaining.set(line.id, available.minus(lineDiscount));
        amount = amount.plus(lineDiscount);
      }
    } else if (coupon.type === "free_delivery") {
      const stillAvailable: RuntimeValue =
        money(deliveryTotal).minus(deliveryDiscount);
      amount = stillAvailable;
      deliveryDiscount = deliveryDiscount.plus(stillAvailable);
    }
    // The cart has no delivery choice yet (deliveryTotal 0), so a free-delivery
    // coupon can only be valued at checkout; do not reject it in the cart.
    if (amount.isZero() && (strictContext || coupon.type !== "free_delivery"))
      couponError(
        "COUPON_NO_DISCOUNT",
        "This coupon does not apply a discount to the current cart.",
      );
    applied.push({
      id: coupon.id,
      code: coupon.code,
      type: coupon.type,
      amount: moneyString(amount),
    });
  }
  const itemDiscountTotal: RuntimeValue = [...discounts.values()].reduce(
    (sum: RuntimeValue, value: RuntimeValue) => sum.plus(value),
    money(0),
  );
  return {
    coupons: applied,
    lineDiscounts: Object.fromEntries(
      [...discounts].map(([id, value]: RuntimeValue) => [
        id,
        moneyString(value),
      ]),
    ),
    itemDiscountTotal: moneyString(itemDiscountTotal),
    deliveryDiscount: moneyString(deliveryDiscount),
    discountTotal: moneyString(itemDiscountTotal.plus(deliveryDiscount)),
  };
}
