import { describe, expect, it } from "vitest";
import {
  claimAmountMatches,
  evaluateClaimEligibility,
  findWalletAccount,
  manualWalletProviders,
  normalizeTrxId,
} from "../../src/modules/payments/manual-wallet.js";

const eligible = {
  orderStatus: "placed",
  paymentMethod: "cod",
  paymentStatus: "unpaid",
  openClaims: 0,
  rejectedClaims: 0,
};

describe("manual wallet TrxID", () => {
  it("normalizes case, spaces and dashes", () => {
    expect(normalizeTrxId(" 8n7a-6d5e e7 ")).toBe("8N7A6D5EE7");
  });
  it("rejects values that cannot be a wallet transaction ID", () => {
    expect(normalizeTrxId("12")).toBeNull();
    expect(normalizeTrxId("abc!def#123")).toBeNull();
    expect(normalizeTrxId("A".repeat(21))).toBeNull();
    expect(normalizeTrxId(null)).toBeNull();
  });
});

describe("manual wallet accounts", () => {
  const settings = {
    enabled: true,
    accounts: [{ provider: "bkash", number: "01712345678" }],
  };
  it("finds the configured account for a provider", () => {
    expect(findWalletAccount(settings, "bkash")?.number).toBe("01712345678");
  });
  it("returns null for unconfigured providers or when disabled", () => {
    expect(findWalletAccount(settings, "nagad")).toBeNull();
    expect(
      findWalletAccount({ ...settings, enabled: false }, "bkash"),
    ).toBeNull();
    expect(findWalletAccount(undefined, "bkash")).toBeNull();
  });
  it("supports the four documented providers", () => {
    expect([...manualWalletProviders]).toEqual([
      "bkash",
      "nagad",
      "rocket",
      "upay",
    ]);
  });
});

describe("manual wallet claim eligibility", () => {
  it("accepts an unpaid COD order", () => {
    expect(evaluateClaimEligibility(eligible)).toEqual({ ok: true });
  });
  it("refuses paid, cancelled or non-COD orders", () => {
    for (const patch of [
      { paymentStatus: "paid" },
      { orderStatus: "cancelled" },
      { orderStatus: "pending_payment" },
      { paymentMethod: "bkash" },
    ])
      expect(evaluateClaimEligibility({ ...eligible, ...patch })).toMatchObject(
        { ok: false, code: "PAYMENT_NOT_ACCEPTED" },
      );
  });
  it("blocks a second claim while one is being checked", () => {
    expect(
      evaluateClaimEligibility({ ...eligible, openClaims: 1 }),
    ).toMatchObject({ ok: false, code: "CLAIM_ALREADY_SUBMITTED" });
  });
  it("allows a resubmission after one rejection but not after two", () => {
    expect(
      evaluateClaimEligibility({ ...eligible, rejectedClaims: 1 }).ok,
    ).toBe(true);
    expect(
      evaluateClaimEligibility({ ...eligible, rejectedClaims: 2 }),
    ).toMatchObject({ ok: false, code: "CLAIM_LIMIT_REACHED" });
  });
});

describe("manual wallet amounts", () => {
  it("compares decimal strings exactly", () => {
    expect(claimAmountMatches("1200.00", "1200")).toBe(true);
    expect(claimAmountMatches("1200.10", "1200.00")).toBe(false);
  });
});
