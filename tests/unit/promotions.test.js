import { describe, expect, it } from "vitest";
import { money } from "../../src/lib/money.js";
import { calculatePromotions } from "../../src/modules/promotions/promotion.service.js";

const coupon = (overrides = {}) => ({
  id: "coupon-1",
  code: "SAVE10",
  type: "fixed_cart",
  amount: "10.00",
  active: true,
  startsAt: null,
  endsAt: null,
  minimumSpend: null,
  maximumSpend: null,
  includeSaleItems: true,
  stackable: false,
  includedProducts: [],
  excludedProducts: [],
  includedCategories: [],
  excludedCategories: [],
  eligibleUsers: [],
  eligiblePhones: [],
  ...overrides,
});

describe("promotion allocation", () => {
  it("allocates fixed-cart discounts deterministically down to the last cent", async () => {
    const result = await calculatePromotions({
      coupons: [coupon()],
      lines: [
        {
          id: "a",
          productId: "p1",
          categoryId: "c1",
          quantity: 1,
          total: money("33.33"),
          onSale: false,
        },
        {
          id: "b",
          productId: "p2",
          categoryId: "c1",
          quantity: 1,
          total: money("66.67"),
          onSale: false,
        },
      ],
      subtotal: money("100.00"),
      deliveryTotal: money(0),
    });
    expect(result.lineDiscounts).toEqual({ a: "3.33", b: "6.67" });
    expect(result.discountTotal).toBe("10.00");
  });

  it("enforces account and phone allowlists when customer identity is known", async () => {
    await expect(
      calculatePromotions({
        coupons: [coupon({ eligibleUsers: [{ id: "allowed-user" }] })],
        lines: [
          {
            id: "a",
            productId: "p1",
            categoryId: "c1",
            quantity: 1,
            total: money("100.00"),
            onSale: false,
          },
        ],
        subtotal: money("100.00"),
        deliveryTotal: money(0),
        userId: "different-user",
      }),
    ).rejects.toMatchObject({ code: "COUPON_CUSTOMER_RESTRICTED" });
  });
});
