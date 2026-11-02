import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ attempt: null, events: [] }));

vi.mock("../../src/db/sequelize.js", () => ({
  sequelize: {
    transaction: async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }),
  },
}));

vi.mock("../../src/db/models.js", () => {
  const model = () => ({
    findOne: vi.fn(async () => null),
    findAll: vi.fn(async () => []),
    findByPk: vi.fn(),
    update: vi.fn(async () => [0]),
    create: vi.fn(async (values) => {
      state.events.push(values);
      return values;
    }),
  });
  const PaymentAttempt = model();
  PaymentAttempt.findByPk = vi.fn(async () => state.attempt);
  PaymentAttempt.findOne = vi.fn(async () => state.attempt);
  return {
    CouponUsage: model(),
    IdempotencyRecord: model(),
    InventoryReservation: model(),
    Order: model(),
    OrderEvent: model(),
    Payment: model(),
    PaymentAttempt,
  };
});

vi.mock("../../src/modules/payments/bkash.adapter.js", () => {
  class BkashProviderError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.code = code;
      this.retryable = Boolean(options.retryable);
      this.uncertain = Boolean(options.uncertain);
    }
  }
  return {
    BkashProviderError,
    createBkashPayment: vi.fn(),
    executeBkashPayment: vi.fn(),
    queryBkashPayment: vi.fn(),
    redactBkashPayload: (value) => value,
  };
});

vi.mock("../../src/modules/orders/order.service.js", () => ({
  createLocalOrderFromQuote: vi.fn(),
  releaseOrderReservations: vi.fn(async () => 0),
}));
vi.mock("../../src/modules/audits/audit.service.js", () => ({
  recordAudit: vi.fn(async () => undefined),
}));
vi.mock("../../src/modules/events/outbox.service.js", () => ({
  addDomainEvent: vi.fn(async () => undefined),
  queueNotification: vi.fn(async () => undefined),
}));
vi.mock(
  "../../src/modules/notifications/staff-notification.service.js",
  () => ({ notifyStaff: vi.fn(async () => undefined) }),
);
vi.mock("../../src/lib/encryption.js", () => ({
  decryptSecret: () => "token",
  encryptSecret: () => "envelope",
}));
vi.mock("../../src/lib/safe-url.js", () => ({
  validateOutboundUrl: vi.fn(),
}));

const { processBkashCallback } =
  await import("../../src/modules/payments/payment.service.js");
const adapter = await import("../../src/modules/payments/bkash.adapter.js");
const orders = await import("../../src/modules/orders/order.service.js");

function saved(target) {
  target.save = vi.fn(async () => target);
  return target;
}

function buildAttempt(status, orderStatus) {
  const order = saved({
    id: "order-1",
    reference: "EE-ABC",
    orderStatus,
    paymentStatus: orderStatus === "pending_payment" ? "pending" : "failed",
    version: 1,
    customerPhone: "+8801700000000",
    locale: "en",
  });
  const payment = saved({
    id: "payment-1",
    amount: "500.00",
    currency: "BDT",
    status: "pending",
    version: 1,
    metadata: {},
    order,
  });
  return saved({
    id: "attempt-1",
    status,
    providerPaymentId: "PID-1",
    requestMetadata: {},
    payment,
  });
}

const completed = {
  paymentID: "PID-1",
  transactionStatus: "Completed",
  amount: "500.00",
  currency: "BDT",
  merchantInvoiceNumber: "EE-ABC",
  trxID: "TRX-1",
  paymentExecuteTime: "2026-01-01T10:00:00:000 GMT+0600",
};

describe("bKash callback settlement", () => {
  beforeEach(() => {
    state.events = [];
    vi.clearAllMocks();
  });

  it("does not fail an attempt from a cancel callback while execute is in flight", async () => {
    state.attempt = buildAttempt("executing", "pending_payment");
    const result = await processBkashCallback("PID-1", "cancel");
    expect(result.state).toBe("checking");
    expect(state.attempt.status).toBe("executing");
    expect(state.attempt.payment.order.orderStatus).toBe("pending_payment");
    expect(orders.releaseOrderReservations).not.toHaveBeenCalled();
  });

  it("releases a cancelled attempt only once", async () => {
    state.attempt = buildAttempt("cancelled", "cancelled");
    await processBkashCallback("PID-1", "cancel");
    expect(orders.releaseOrderReservations).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });

  it("records a late capture without re-placing a released order", async () => {
    state.attempt = buildAttempt("expired", "failed");
    adapter.queryBkashPayment.mockResolvedValue(completed);
    await processBkashCallback("PID-1", "success");
    const { payment } = state.attempt;
    expect(payment.status).toBe("paid");
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect(Number.isNaN(payment.paidAt.getTime())).toBe(false);
    expect(payment.order.paymentStatus).toBe("paid");
    expect(payment.order.orderStatus).toBe("failed");
    expect(state.events.map((event) => event.type)).toContain(
      "payment_paid_late",
    );
  });

  it("fails an attempt whose execute call was definitively rejected", async () => {
    state.attempt = buildAttempt("redirected", "pending_payment");
    const models = await import("../../src/db/models.js");
    models.PaymentAttempt.update.mockResolvedValueOnce([1]);
    adapter.executeBkashPayment.mockRejectedValue(
      new adapter.BkashProviderError("BKASH_2056", "Invalid payment state"),
    );
    adapter.queryBkashPayment.mockResolvedValue({
      paymentID: "PID-1",
      transactionStatus: "Initiated",
    });
    const result = await processBkashCallback("PID-1", "success");
    expect(result.state).toBe("failed");
    expect(state.attempt.payment.order.orderStatus).toBe("failed");
  });
});
