import { describe, expect, it } from "vitest";
import {
  computeRisk,
  enforceRiskPolicy,
} from "../../src/modules/orders/risk.service.js";
import { confirmationDecision } from "../../src/modules/orders/confirmation.service.js";

const clean = {
  blocked: false,
  rtoCount: 0,
  cancelledCount: 0,
  deliveredCount: 0,
  wrongNumberCount: 0,
  recentOrderCount: 0,
  firstOrderHighValue: false,
  possibleDuplicate: false,
};
const thresholds = { mediumScore: 30, highScore: 60 };

describe("COD risk scoring", () => {
  it("treats a clean new customer as low risk", () => {
    expect(computeRisk(clean, thresholds)).toEqual({
      score: 0,
      level: "low",
      signals: [],
    });
  });

  it("blocks blocklisted customers regardless of history", () => {
    const result = computeRisk(
      { ...clean, blocked: true, deliveredCount: 20 },
      thresholds,
    );
    expect(result.level).toBe("blocked");
    expect(result.signals).toEqual(["blocklisted"]);
  });

  it("flags repeated returns to origin as high risk", () => {
    const result = computeRisk({ ...clean, rtoCount: 2 }, thresholds);
    expect(result.level).toBe("high");
    expect(result.signals).toContain("previous_return_to_origin");
  });

  it("lets delivery history reduce but not erase risk", () => {
    const risky = computeRisk(
      { ...clean, rtoCount: 1, wrongNumberCount: 1 },
      thresholds,
    );
    const trusted = computeRisk(
      { ...clean, rtoCount: 1, wrongNumberCount: 1, deliveredCount: 5 },
      thresholds,
    );
    expect(risky.score).toBe(50);
    expect(trusted.score).toBe(20);
    expect(trusted.level).toBe("low");
  });

  it("scores duplicates and high-value first orders as medium", () => {
    const result = computeRisk(
      { ...clean, firstOrderHighValue: true, possibleDuplicate: true },
      thresholds,
    );
    expect(result).toMatchObject({ score: 30, level: "medium" });
  });

  it("enforces the owner's high-risk policy without leaking reasons", () => {
    expect(() =>
      enforceRiskPolicy({ level: "blocked", action: null }, "cod"),
    ).toThrow(expect.objectContaining({ code: "ORDER_NOT_ACCEPTED" }));
    expect(() =>
      enforceRiskPolicy({ level: "high", action: "block_cod" }, "cod"),
    ).toThrow(expect.objectContaining({ code: "COD_NOT_AVAILABLE" }));
    expect(() =>
      enforceRiskPolicy({ level: "high", action: "block_cod" }, "bkash"),
    ).not.toThrow();
    expect(() =>
      enforceRiskPolicy(
        { level: "high", action: "require_confirmation" },
        "cod",
      ),
    ).not.toThrow();
  });
});

describe("order confirmation decisions", () => {
  it("confirms and cancels on explicit outcomes", () => {
    expect(confirmationDecision("confirmed", 0, 3)).toBe("confirm");
    expect(confirmationDecision("customer_cancelled", 0, 3)).toBe("cancel");
  });

  it("auto-cancels after the last failed attempt only", () => {
    expect(confirmationDecision("no_answer", 2, 3)).toBe("retry");
    expect(confirmationDecision("no_answer", 3, 3)).toBe("auto_cancel");
    expect(confirmationDecision("wrong_number", 3, 3)).toBe("auto_cancel");
  });

  it("never auto-cancels a requested call back", () => {
    expect(confirmationDecision("call_back", 9, 3)).toBe("retry");
  });
});
