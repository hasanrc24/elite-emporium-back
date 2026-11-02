import { Op } from "sequelize";
import {
  CheckoutQuote,
  CouponUsage,
  IdempotencyRecord,
  InventoryReservation,
  Order,
  OrderEvent,
  Payment,
  PaymentAttempt,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { sha256 } from "../../lib/crypto.js";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";
import { AppError } from "../../lib/errors.js";
import { newId, randomToken } from "../../lib/ids.js";
import { money, moneyString } from "../../lib/money.js";
import { validateOutboundUrl } from "../../lib/safe-url.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent, queueNotification } from "../events/outbox.service.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { releasePurchaseEvent } from "../tracking/meta-capi.service.js";
import {
  createLocalOrderFromQuote,
  releaseOrderReservations,
} from "../orders/order.service.js";
import {
  BkashProviderError,
  createBkashPayment,
  executeBkashPayment,
  queryBkashPayment,
  redactBkashPayload,
} from "./bkash.adapter.js";

const attemptInclude: RuntimeValue = [
  { model: Payment, as: "payment", include: [{ model: Order, as: "order" }] },
];

function publicAttempt(
  attempt: RuntimeValue,
  recoveryToken: RuntimeValue = null,
) {
  const order = attempt.payment.order;
  return {
    state:
      attempt.status === "succeeded"
        ? "paid"
        : attempt.status === "cancelled"
          ? "cancelled"
          : attempt.status === "failed" || attempt.status === "expired"
            ? "failed"
            : attempt.status === "redirected"
              ? "redirect"
              : "checking",
    attemptId: attempt.id,
    orderReference: order.reference,
    orderId: order.id,
    redirectUrl: attempt.redirectUrl || null,
    expiresAt: attempt.expiresAt,
    recoveryToken,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
  };
}

function attemptRecoveryToken(attempt: RuntimeValue) {
  const envelope = attempt.requestMetadata?.recoveryTokenEncrypted;
  return envelope ? decryptSecret(envelope) : null;
}

async function loadAttempt(
  id: RuntimeValue,
  transaction: RuntimeValue = null,
  lock: RuntimeValue = null,
) {
  return PaymentAttempt.findByPk(id, {
    include: attemptInclude,
    transaction,
    lock,
  });
}

export async function startBkashPayment(
  cartId: RuntimeValue,
  userId: RuntimeValue,
  payload: RuntimeValue,
  idempotencyKey: RuntimeValue,
  request: RuntimeValue,
) {
  if (!idempotencyKey)
    throw AppError.badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required.",
    );
  // Same scoping as COD orders: the guest cart is converted after the first
  // attempt, so retries are keyed to the cart that owns the quote.
  const quoteOwner: RuntimeValue = userId
    ? null
    : await CheckoutQuote.findByPk(payload.quoteId, { attributes: ["cartId"] });
  const actorKey = userId || quoteOwner?.cartId || cartId;
  const requestHash: RuntimeValue = sha256(canonicalJson(payload));
  const local: RuntimeValue = await sequelize.transaction(
    async (transaction: RuntimeValue) => {
      const [record]: RuntimeValue = await IdempotencyRecord.findOrCreate({
        where: {
          scope: "payments.bkash.create",
          key: idempotencyKey,
          actorKey,
        },
        defaults: {
          id: newId(),
          scope: "payments.bkash.create",
          key: idempotencyKey,
          actorKey,
          requestHash,
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
        transaction,
      });
      await record.reload({ transaction, lock: transaction.LOCK.UPDATE });
      if (record.requestHash !== requestHash)
        throw AppError.conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "This payment key was already used for different details.",
        );
      if (record.responseBody?.attemptId) {
        const attempt: RuntimeValue = await loadAttempt(
          record.responseBody.attemptId,
          transaction,
          transaction.LOCK.UPDATE,
        );
        if (!attempt)
          throw new Error(
            "Idempotency record references a missing payment attempt",
          );
        return {
          recordId: record.id,
          attemptId: attempt.id,
          shouldCreate: false,
          response: publicAttempt(attempt, attemptRecoveryToken(attempt)),
        };
      }
      const { order, payment }: RuntimeValue = await createLocalOrderFromQuote({
        cartId,
        userId,
        quoteId: payload.quoteId,
        idempotencyKey,
        paymentMethod: "bkash",
        transaction,
        request,
      });
      const recoveryToken: RuntimeValue = randomToken();
      const expiresAt = new Date(Date.now() + 15 * 60000);
      const attempt: RuntimeValue = await PaymentAttempt.create(
        {
          id: newId(),
          paymentId: payment.id,
          idempotencyKey,
          recoveryTokenHash: sha256(recoveryToken),
          amount: payment.amount,
          status: "executing",
          requestMetadata: {
            phase: "create",
            recoveryTokenEncrypted: encryptSecret(recoveryToken),
          },
          responseMetadata: {},
          callbackState: {},
          expiresAt,
        },
        { transaction },
      );
      record.responseStatus = 202;
      record.responseBody = {
        state: "creating",
        attemptId: attempt.id,
        orderId: order.id,
      };
      await record.save({ transaction });
      return {
        recordId: record.id,
        attemptId: attempt.id,
        shouldCreate: true,
        response: {
          state: "checking",
          attemptId: attempt.id,
          orderReference: order.reference,
          orderId: order.id,
          redirectUrl: null,
          expiresAt,
          recoveryToken,
          paymentStatus: order.paymentStatus,
          orderStatus: order.orderStatus,
        },
      };
    },
  );
  if (!local.shouldCreate) return local.response;
  const attempt: RuntimeValue = await loadAttempt(local.attemptId);
  try {
    const provider: RuntimeValue = await createBkashPayment({
      amount: moneyString(attempt.amount),
      invoice: attempt.payment.order.reference,
      locale: attempt.payment.order.locale,
    });
    if (
      provider.amount != null &&
      !money(provider.amount).equals(attempt.amount)
    )
      throw new BkashProviderError(
        "BKASH_AMOUNT_MISMATCH",
        "bKash returned a different payment amount.",
      );
    if (provider.currency && provider.currency !== "BDT")
      throw new BkashProviderError(
        "BKASH_CURRENCY_MISMATCH",
        "bKash returned a different currency.",
      );
    if (
      provider.merchantInvoiceNumber &&
      provider.merchantInvoiceNumber !== attempt.payment.order.reference
    )
      throw new BkashProviderError(
        "BKASH_INVOICE_MISMATCH",
        "bKash returned a different invoice reference.",
      );
    const redirectCandidate = new URL(provider.bkashURL);
    if (
      redirectCandidate.protocol !== "https:" ||
      (redirectCandidate.hostname !== "bka.sh" &&
        !redirectCandidate.hostname.endsWith(".bka.sh"))
    )
      throw new BkashProviderError(
        "BKASH_REDIRECT_REJECTED",
        "bKash returned an unsafe redirect URL.",
      );
    const redirect: RuntimeValue = await validateOutboundUrl(
      provider.bkashURL,
      [redirectCandidate.hostname],
    );
    return sequelize.transaction(async (transaction: RuntimeValue) => {
      const locked: RuntimeValue = await loadAttempt(
        attempt.id,
        transaction,
        transaction.LOCK.UPDATE,
      );
      if (
        locked.providerPaymentId &&
        locked.providerPaymentId !== provider.paymentID
      )
        throw AppError.conflict(
          "PAYMENT_PROVIDER_CONFLICT",
          "This payment attempt already has a different provider ID.",
        );
      locked.providerPaymentId = provider.paymentID;
      locked.redirectUrl = redirect.toString();
      locked.status = "redirected";
      locked.responseMetadata = redactBkashPayload(provider);
      locked.requestMetadata = { ...locked.requestMetadata, phase: "redirect" };
      await locked.save({ transaction });
      const record: RuntimeValue = await IdempotencyRecord.findByPk(
        local.recordId,
        {
          transaction,
          lock: transaction.LOCK.UPDATE,
        },
      );
      record.responseStatus = 200;
      record.responseBody = {
        state: "redirect",
        attemptId: locked.id,
        orderId: locked.payment.order.id,
      };
      await record.save({ transaction });
      return publicAttempt(locked, attemptRecoveryToken(locked));
    });
  } catch (error: RuntimeValue) {
    const providerError =
      error instanceof BkashProviderError
        ? error
        : new BkashProviderError(
            "BKASH_CREATE_FAILED",
            "bKash payment creation failed.",
          );
    await handleCreateFailure(attempt.id, providerError);
    throw new AppError(
      providerError.retryable ? 503 : 422,
      providerError.code,
      providerError.uncertain
        ? "Payment confirmation is pending because bKash did not return a definite result. Use payment recovery before trying again."
        : providerError.message,
    );
  }
}

async function handleCreateFailure(
  attemptId: RuntimeValue,
  error: RuntimeValue,
) {
  await sequelize.transaction(async (transaction: RuntimeValue) => {
    const attempt: RuntimeValue = await loadAttempt(
      attemptId,
      transaction,
      transaction.LOCK.UPDATE,
    );
    if (!attempt || attempt.status === "succeeded") return;
    attempt.callbackState = {
      createError: error.code,
      uncertain: error.uncertain,
    };
    attempt.requestMetadata = {
      ...attempt.requestMetadata,
      phase: error.uncertain ? "create_uncertain" : "create_failed",
    };
    if (!error.uncertain) {
      attempt.status = "failed";
      attempt.payment.status = "failed";
      attempt.payment.failedAt = new Date();
      attempt.payment.order.orderStatus = "failed";
      attempt.payment.order.paymentStatus = "failed";
      await attempt.payment.save({ transaction });
      await attempt.payment.order.save({ transaction });
      await releaseOrderReservations(
        attempt.payment.order.id,
        "payment_failed",
        transaction,
        null,
        ["active"],
      );
      await CouponUsage.update(
        { status: "released" },
        {
          where: { orderId: attempt.payment.order.id, status: "reserved" },
          transaction,
        },
      );
    } else {
      attempt.status = "created";
    }
    await attempt.save({ transaction });
  });
}

function validateProviderSuccess(
  attempt: RuntimeValue,
  provider: RuntimeValue,
) {
  const order = attempt.payment.order;
  if (provider.paymentID && provider.paymentID !== attempt.providerPaymentId)
    throw AppError.conflict(
      "BKASH_PAYMENT_ID_MISMATCH",
      "bKash returned a different payment ID.",
    );
  if (provider.transactionStatus !== "Completed") return false;
  if (!money(provider.amount).equals(attempt.payment.amount))
    throw AppError.conflict(
      "BKASH_AMOUNT_MISMATCH",
      "bKash returned a different payment amount.",
    );
  if (provider.currency !== "BDT")
    throw AppError.conflict(
      "BKASH_CURRENCY_MISMATCH",
      "bKash returned a different currency.",
    );
  if (provider.merchantInvoiceNumber !== order.reference)
    throw AppError.conflict(
      "BKASH_INVOICE_MISMATCH",
      "bKash returned a different invoice reference.",
    );
  if (!provider.trxID)
    throw AppError.conflict(
      "BKASH_TRANSACTION_MISSING",
      "bKash did not return a transaction ID.",
    );
  return true;
}

async function finalizeSuccess(
  attemptId: RuntimeValue,
  provider: RuntimeValue,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const attempt: RuntimeValue = await loadAttempt(
      attemptId,
      transaction,
      transaction.LOCK.UPDATE,
    );
    if (!attempt) throw AppError.notFound("Payment attempt not found.");
    if (attempt.status === "succeeded") return publicAttempt(attempt);
    if (!validateProviderSuccess(attempt, provider))
      return publicAttempt(attempt);
    const duplicate: RuntimeValue = await Payment.findOne({
      where: {
        providerTransactionId: provider.trxID,
        id: { [Op.ne]: attempt.payment.id },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (duplicate)
      throw AppError.conflict(
        "BKASH_TRANSACTION_REUSED",
        "This bKash transaction is already linked to another payment.",
      );
    const payment = attempt.payment;
    const order = payment.order;
    // The order was already failed/cancelled (expiry job, cancel callback or
    // staff) and its stock reservations and coupon usage were released. Record
    // the captured money, but do not silently re-place an unreserved order.
    const lateCapture = order.orderStatus !== "pending_payment";
    attempt.status = "succeeded";
    attempt.responseMetadata = redactBkashPayload(provider);
    await attempt.save({ transaction });
    payment.status = "paid";
    payment.providerTransactionId = provider.trxID;
    const executedAt = provider.paymentExecuteTime
      ? new Date(provider.paymentExecuteTime)
      : null;
    payment.paidAt =
      executedAt && !Number.isNaN(executedAt.getTime())
        ? executedAt
        : new Date();
    payment.version += 1;
    payment.metadata = {
      ...payment.metadata,
      providerStatus: provider.transactionStatus,
      ...(lateCapture ? { lateCapture: true } : {}),
    };
    await payment.save({ transaction });
    if (lateCapture) {
      const previousStatus = order.orderStatus;
      order.paymentStatus = "paid";
      order.version += 1;
      await order.save({ transaction });
      await OrderEvent.create(
        {
          id: newId(),
          orderId: order.id,
          type: "payment_paid_late",
          fromStatus: previousStatus,
          toStatus: previousStatus,
          message:
            "bKash payment was confirmed after the order closed. Refund or reinstate it manually.",
          public: false,
          metadata: { paymentId: payment.id },
        },
        { transaction },
      );
      await addDomainEvent({
        topic: "payment.paid",
        aggregateType: "payment",
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: order.id,
          reference: order.reference,
          amount: moneyString(payment.amount),
          currency: payment.currency,
          method: "bkash",
          lateCapture: true,
        },
        transaction,
      });
      await notifyStaff("payments", {
        event: "payment.late_capture",
        title: `Late bKash payment on ${order.reference}`,
        message: `৳${moneyString(payment.amount)} was captured after the order closed. Refund it or reinstate the order.`,
        link: `/admin/orders/${order.id}`,
        severity: "critical",
        data: { orderId: order.id, paymentId: payment.id },
        transaction,
      });
      await recordAudit({
        action: "payment.bkash_confirmed_late",
        resourceType: "payment",
        resourceId: payment.id,
        after: {
          orderId: order.id,
          orderStatus: previousStatus,
          transactionId: provider.trxID,
          amount: moneyString(payment.amount),
        },
        transaction,
      });
      return publicAttempt(attempt);
    }
    order.paymentStatus = "paid";
    order.orderStatus = "placed";
    order.placedAt = new Date();
    order.version += 1;
    await order.save({ transaction });
    const reservations: RuntimeValue = await InventoryReservation.findAll({
      where: { orderId: order.id, status: "active" },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const reservation of reservations) {
      reservation.status = "converted";
      reservation.convertedAt = new Date();
      await reservation.save({ transaction });
    }
    await CouponUsage.update(
      { status: "consumed" },
      { where: { orderId: order.id, status: "reserved" }, transaction },
    );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: order.id,
        type: "payment_paid",
        fromStatus: "pending_payment",
        toStatus: "placed",
        message: "bKash payment confirmed.",
        public: true,
        metadata: { paymentId: payment.id },
      },
      { transaction },
    );
    await addDomainEvent({
      topic: "payment.paid",
      aggregateType: "payment",
      aggregateId: payment.id,
      payload: {
        paymentId: payment.id,
        orderId: order.id,
        reference: order.reference,
        amount: moneyString(payment.amount),
        currency: payment.currency,
        method: "bkash",
      },
      transaction,
    });
    await releasePurchaseEvent(order.reference, transaction);
    await queueNotification({
      event: "payment.paid",
      channel: order.customerEmail ? "email" : "sms",
      locale: order.locale,
      recipient: order.customerEmail || order.customerPhone,
      payload: {
        message: `Payment for order ${order.reference} was confirmed.`,
        orderReference: order.reference,
      },
      transaction,
    });
    // A paid bKash order is only "placed" now, so this is its new-order alert.
    await notifyStaff("orders", {
      event: "order.placed",
      title: `New paid order ${order.reference}`,
      message: `${order.customerName} · ৳${moneyString(payment.amount)} paid by bKash.`,
      link: `/admin/orders/${order.id}`,
      severity: "success",
      data: { orderId: order.id, orderReference: order.reference },
      transaction,
    });
    await recordAudit({
      action: "payment.bkash_confirmed",
      resourceType: "payment",
      resourceId: payment.id,
      after: {
        orderId: order.id,
        transactionId: provider.trxID,
        amount: moneyString(payment.amount),
      },
      transaction,
    });
    return publicAttempt(attempt);
  });
}

async function finalizeFailure(
  attemptId: RuntimeValue,
  status: RuntimeValue,
  provider: RuntimeValue = {},
  unverified: boolean = false,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const attempt: RuntimeValue = await loadAttempt(
      attemptId,
      transaction,
      transaction.LOCK.UPDATE,
    );
    if (!attempt) throw AppError.notFound("Payment attempt not found.");
    // Release exactly once: an already failed/cancelled attempt was finalized.
    if (["succeeded", "failed", "cancelled"].includes(attempt.status))
      return publicAttempt(attempt);
    // An unverified browser callback must not fail an attempt whose execute
    // call is in flight; the provider query decides that outcome.
    if (unverified && attempt.status === "executing")
      return publicAttempt(attempt);
    const cancelled = status === "cancelled";
    const order = attempt.payment.order;
    const previousOrderStatus = order.orderStatus;
    attempt.status = cancelled ? "cancelled" : "failed";
    attempt.callbackState = redactBkashPayload(provider);
    await attempt.save({ transaction });
    attempt.payment.status = cancelled ? "cancelled" : "failed";
    attempt.payment[cancelled ? "cancelledAt" : "failedAt"] = new Date();
    await attempt.payment.save({ transaction });
    if (["pending_payment", "failed"].includes(order.orderStatus)) {
      order.orderStatus = cancelled ? "cancelled" : "failed";
      order.paymentStatus = cancelled ? "cancelled" : "failed";
      if (cancelled) order.cancelledAt = new Date();
      order.version += 1;
      await order.save({ transaction });
    }
    await releaseOrderReservations(
      attempt.payment.order.id,
      cancelled ? "payment_cancelled" : "payment_failed",
      transaction,
      null,
      ["active"],
    );
    await CouponUsage.update(
      { status: "released" },
      {
        where: { orderId: attempt.payment.order.id, status: "reserved" },
        transaction,
      },
    );
    await OrderEvent.create(
      {
        id: newId(),
        orderId: attempt.payment.order.id,
        type: cancelled ? "payment_cancelled" : "payment_failed",
        fromStatus: previousOrderStatus,
        toStatus: order.orderStatus,
        message: cancelled
          ? "bKash payment was cancelled."
          : "bKash payment failed.",
        public: true,
      },
      { transaction },
    );
    return publicAttempt(attempt);
  });
}

/**
 * Settles an attempt after a browser callback or recovery poll. The callback
 * status is never proof of payment: success is only recorded from a verified
 * execute/query response, and a cancel/failure callback cannot fail an attempt
 * whose execute call is in flight.
 */
async function settleAttempt(
  attempt: RuntimeValue,
  callbackStatus: RuntimeValue,
) {
  if (callbackStatus === "cancel" || callbackStatus === "failure")
    return finalizeFailure(
      attempt.id,
      callbackStatus === "cancel" ? "cancelled" : "failed",
      { callbackStatus },
      true,
    );
  if (!attempt.providerPaymentId) return publicAttempt(attempt);
  let executeRejected = false;
  if (callbackStatus === "success" && attempt.status === "redirected") {
    const claimed: RuntimeValue = await PaymentAttempt.update(
      { status: "executing", callbackState: { callbackStatus: "success" } },
      { where: { id: attempt.id, status: "redirected" } },
    );
    if (claimed[0]) {
      try {
        const executed: RuntimeValue = await executeBkashPayment(
          attempt.providerPaymentId,
        );
        if (executed.transactionStatus === "Completed")
          return finalizeSuccess(attempt.id, executed);
      } catch (error: RuntimeValue) {
        if (!(error instanceof BkashProviderError)) throw error;
        // A definite rejection must not leave the attempt stuck in
        // "executing"; the authoritative query below decides the outcome.
        executeRejected = !error.uncertain && !error.retryable;
      }
    }
  }
  let queried;
  try {
    queried = await queryBkashPayment(attempt.providerPaymentId);
  } catch (error: RuntimeValue) {
    throw error instanceof BkashProviderError
      ? new AppError(error.retryable ? 503 : 422, error.code, error.message)
      : error;
  }
  if (queried.transactionStatus === "Completed")
    return finalizeSuccess(attempt.id, queried);
  if (["Cancelled", "Canceled"].includes(queried.transactionStatus))
    return finalizeFailure(attempt.id, "cancelled", queried);
  if (
    executeRejected ||
    ["Failed", "Expired"].includes(queried.transactionStatus)
  )
    return finalizeFailure(attempt.id, "failed", queried);
  return publicAttempt(await loadAttempt(attempt.id));
}

export async function recoverBkashPayment({
  attemptId,
  recoveryToken,
  callbackStatus = null,
}: RuntimeValue) {
  const attempt: RuntimeValue = await loadAttempt(attemptId);
  if (!attempt || attempt.recoveryTokenHash !== sha256(recoveryToken))
    throw AppError.notFound("Payment attempt not found.");
  if (["succeeded", "failed", "cancelled", "expired"].includes(attempt.status))
    return publicAttempt(attempt);
  return settleAttempt(attempt, callbackStatus);
}

export async function processBkashCallback(
  paymentId: RuntimeValue,
  callbackStatus: RuntimeValue,
) {
  const attempt: RuntimeValue = await PaymentAttempt.findOne({
    where: { providerPaymentId: paymentId },
    include: attemptInclude,
  });
  if (!attempt) throw AppError.notFound("Payment attempt not found.");
  if (attempt.status === "succeeded") return publicAttempt(attempt);
  return settleAttempt(attempt, callbackStatus);
}
