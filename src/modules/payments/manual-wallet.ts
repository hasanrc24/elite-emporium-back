import { money } from "../../lib/money.js";

/**
 * BR-PAY-006 / BE-PAY-005: manual mobile-wallet payments. A customer sends
 * money to the shop's wallet number and reports the transaction ID (TrxID);
 * staff verify it. These are the pure rules, kept free of I/O so they can be
 * unit tested.
 */
export const manualWalletProviders = [
  "bkash",
  "nagad",
  "rocket",
  "upay",
] as const;

/** A customer may be rejected this many times before support must step in. */
const maxClaimAttempts = 2;

/** Orders in these states can still receive a wallet payment. */
const payableOrderStatuses = ["placed", "confirmed", "processing"];

export type WalletAccount = {
  provider: string;
  number: string;
  accountType?: string;
};
export type ManualWalletSettings = {
  enabled?: boolean;
  accounts?: WalletAccount[];
};

/** Wallet TrxIDs are short alphanumeric codes; spaces and dashes are noise. */
export function normalizeTrxId(input: unknown): string | null {
  const value = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  return /^[A-Z0-9]{6,20}$/.test(value) ? value : null;
}

export function findWalletAccount(
  settings: ManualWalletSettings | null | undefined,
  provider: string,
): WalletAccount | null {
  if (!settings?.enabled) return null;
  return (
    (settings.accounts ?? []).find(
      (account) => account.provider === provider,
    ) ?? null
  );
}

export type ClaimEligibilityInput = {
  orderStatus: string;
  paymentMethod: string;
  paymentStatus: string;
  openClaims: number;
  rejectedClaims: number;
};
export type ClaimEligibility =
  { ok: true } | { ok: false; code: string; message: string };

export function evaluateClaimEligibility(
  input: ClaimEligibilityInput,
): ClaimEligibility {
  if (
    !payableOrderStatuses.includes(input.orderStatus) ||
    input.paymentMethod !== "cod" ||
    input.paymentStatus !== "unpaid"
  )
    return {
      ok: false,
      code: "PAYMENT_NOT_ACCEPTED",
      message: "This order can no longer receive a wallet payment.",
    };
  if (input.openClaims > 0)
    return {
      ok: false,
      code: "CLAIM_ALREADY_SUBMITTED",
      message: "A payment reference for this order is already being checked.",
    };
  if (input.rejectedClaims >= maxClaimAttempts)
    return {
      ok: false,
      code: "CLAIM_LIMIT_REACHED",
      message:
        "Too many payment references were submitted. Please contact support.",
    };
  return { ok: true };
}

/** The amount a customer must send is always the outstanding order payment. */
export function claimAmountMatches(claimed: unknown, expected: unknown) {
  return money(claimed as string).equals(money(expected as string));
}
