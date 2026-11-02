import { Op, UniqueConstraintError } from "sequelize";
import {
  ManualPaymentClaim,
  Order,
  OrderEvent,
  Payment,
} from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { moneyString } from "../../lib/money.js";
import { normalizePhone } from "../../lib/normalization.js";
import { pageEnvelope, pagination } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";
import { addDomainEvent } from "../events/outbox.service.js";
import { notifyStaff } from "../notifications/staff-notification.service.js";
import { settingValue } from "../settings/settings.service.js";
import {
  evaluateClaimEligibility,
  findWalletAccount,
  normalizeTrxId,
  type ManualWalletSettings,
} from "./manual-wallet.js";

const claimStatuses = ["submitted", "verified", "rejected", "expired"];

function claimDto(claim: RuntimeValue, includeOrder = false) {
  return {
    id: claim.id,
    provider: claim.provider,
    senderPhone: claim.senderPhone,
    trxId: claim.trxId,
    amount: moneyString(claim.amount),
    status: claim.status,
    rejectionReason: claim.rejectionReason ?? null,
    reviewedAt: claim.reviewedAt ?? null,
    createdAt: claim.createdAt,
    version: claim.version,
    ...(includeOrder && claim.order
      ? {
          order: {
            id: claim.order.id,
            reference: claim.order.reference,
            customerName: claim.order.customerName,
            customerPhone: claim.order.customerPhone,
            grandTotal: moneyString(claim.order.grandTotal),
            orderStatus: claim.order.orderStatus,
            paymentStatus: claim.order.paymentStatus,
          },
        }
      : {}),
  };
}

/** What the customer sees: no staff fields and a masked TrxID. */
function publicClaimDto(claim: RuntimeValue, reference: string) {
  const trx = String(claim.trxId);
  return {
    id: claim.id,
    reference,
    provider: claim.provider,
    amount: moneyString(claim.amount),
    status: claim.status,
    trxId: `${"*".repeat(Math.max(0, trx.length - 4))}${trx.slice(-4)}`,
    createdAt: claim.createdAt,
  };
}

export async function submitManualPayment(
  payload: RuntimeValue,
  request: RuntimeValue = null,
) {
  const phone = normalizePhone(payload.phone);
  const senderPhone = normalizePhone(payload.senderPhone);
  const trxId = normalizeTrxId(payload.trxId);
  if (!senderPhone)
    throw AppError.unprocessable(
      "INVALID_PHONE",
      "Enter the wallet number you paid from.",
      { senderPhone: ["Enter a valid Bangladeshi phone number."] },
    );
  if (!trxId)
    throw AppError.unprocessable(
      "INVALID_TRX_ID",
      "Check the transaction ID and try again.",
      { trxId: ["Enter the transaction ID from your payment message."] },
    );
  try {
    return await sequelize.transaction(async (transaction: RuntimeValue) => {
      const order: RuntimeValue = await Order.findOne({
        where: { reference: String(payload.reference).trim().toUpperCase() },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      // The same message for a wrong reference or phone avoids order probing.
      if (!order || !phone || order.customerPhone !== phone)
        throw AppError.notFound("Order not found.");
      const payment: RuntimeValue = await Payment.findOne({
        where: { orderId: order.id, method: "cod" },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!payment)
        throw AppError.unprocessable(
          "PAYMENT_NOT_ACCEPTED",
          "This order can no longer receive a wallet payment.",
        );
      const settings: ManualWalletSettings = await settingValue(
        "manualWallet",
        transaction,
      );
      if (!findWalletAccount(settings, payload.provider))
        throw AppError.unprocessable(
          "PAYMENT_UNAVAILABLE",
          "This payment method is not currently available.",
        );
      const [openClaims, rejectedClaims] = await Promise.all([
        ManualPaymentClaim.count({
          where: { orderId: order.id, status: "submitted" },
          transaction,
        }),
        ManualPaymentClaim.count({
          where: { orderId: order.id, status: "rejected" },
          transaction,
        }),
      ]);
      const eligibility = evaluateClaimEligibility({
        orderStatus: order.orderStatus,
        paymentMethod: payment.method,
        paymentStatus: payment.status,
        openClaims,
        rejectedClaims,
      });
      if (!eligibility.ok)
        throw AppError.conflict(eligibility.code, eligibility.message);
      const reused = await ManualPaymentClaim.findOne({
        where: { provider: payload.provider, trxId },
        transaction,
      });
      if (reused)
        throw AppError.conflict(
          "TRX_ID_ALREADY_USED",
          "This transaction ID has already been submitted.",
        );
      const claim: RuntimeValue = await ManualPaymentClaim.create(
        {
          id: newId(),
          orderId: order.id,
          paymentId: payment.id,
          provider: payload.provider,
          senderPhone,
          trxId,
          amount: payment.amount,
          status: "submitted",
        },
        { transaction },
      );
      await OrderEvent.create(
        {
          id: newId(),
          orderId: order.id,
          actorId: null,
          type: "manual_payment_submitted",
          message: "Payment reference received. We are checking it.",
          public: true,
          metadata: { claimId: claim.id, provider: claim.provider },
        },
        { transaction },
      );
      await notifyStaff("payments", {
        event: "payment.manual_submitted",
        title: `Wallet payment to verify for ${order.reference}`,
        message: `${String(payload.provider).toUpperCase()} · ৳${moneyString(payment.amount)} · TrxID ${trxId}`,
        link: "/admin/payments/manual",
        severity: "info",
        dedupeKey: `payment.manual_submitted:${claim.id}`,
        data: { orderId: order.id, orderReference: order.reference },
        transaction,
      });
      await recordAudit({
        actorId: null,
        action: "payment.manual_submit",
        resourceType: "manual_payment_claim",
        resourceId: claim.id,
        after: {
          orderId: order.id,
          provider: claim.provider,
          amount: moneyString(payment.amount),
        },
        request,
        transaction,
      });
      return publicClaimDto(claim, order.reference);
    });
  } catch (error) {
    // Two submissions of one TrxID can race past the pre-check; the unique
    // index is the final authority.
    if (error instanceof UniqueConstraintError)
      throw AppError.conflict(
        "TRX_ID_ALREADY_USED",
        "This transaction ID has already been submitted.",
      );
    throw error;
  }
}

export async function listManualPayments(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (claimStatuses.includes(String(query.status))) where.status = query.status;
  const result: RuntimeValue = await ManualPaymentClaim.findAndCountAll({
    where,
    include: [{ model: Order, as: "order" }],
    order: [["createdAt", "ASC"]],
    distinct: true,
    limit,
    offset,
  });
  return pageEnvelope(
    {
      rows: result.rows.map((claim: RuntimeValue) => claimDto(claim, true)),
      count: result.count,
    },
    page,
    pageSize,
  );
}

async function lockSubmittedClaim(id: RuntimeValue, transaction: RuntimeValue) {
  const claim: RuntimeValue = await ManualPaymentClaim.findByPk(id, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!claim) throw AppError.notFound("Payment claim not found.");
  if (claim.status !== "submitted")
    throw AppError.conflict(
      "CLAIM_ALREADY_REVIEWED",
      "This payment claim was already reviewed.",
    );
  return claim;
}

/**
 * Marks the order's payment as received. It follows collectCod: the same
 * state changes, events and domain event, so refunds, completion and reports
 * treat a verified wallet payment like any other captured payment.
 */
export async function verifyManualPayment(
  id: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue = null,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const claim = await lockSubmittedClaim(id, transaction);
    const payment: RuntimeValue = await Payment.findByPk(claim.paymentId, {
      include: [{ model: Order, as: "order" }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment || payment.method !== "cod" || payment.status !== "unpaid")
      throw AppError.conflict(
        "PAYMENT_NOT_COLLECTABLE",
        "This order can no longer be marked as paid.",
      );
    const now = new Date();
    payment.status = "paid";
    payment.paidAt = now;
    payment.reference = `${claim.provider}:${claim.trxId}`.slice(0, 190);
    payment.metadata = {
      ...payment.metadata,
      manualWallet: {
        claimId: claim.id,
        provider: claim.provider,
        trxId: claim.trxId,
        senderPhone: claim.senderPhone,
        verifiedBy: actorId,
      },
    };
    payment.version += 1;
    await payment.save({ transaction });
    payment.order.paymentStatus = "paid";
    if (payment.order.fulfillmentStatus === "delivered") {
      payment.order.orderStatus = "completed";
      payment.order.completedAt = now;
    }
    payment.order.version += 1;
    await payment.order.save({ transaction });
    claim.status = "verified";
    claim.reviewedBy = actorId;
    claim.reviewedAt = now;
    claim.version += 1;
    await claim.save({ transaction });
    await OrderEvent.create(
      {
        id: newId(),
        orderId: payment.order.id,
        actorId,
        type: "manual_payment_verified",
        message: "Wallet payment verified.",
        public: true,
        metadata: { claimId: claim.id, paymentId: payment.id },
      },
      { transaction },
    );
    await addDomainEvent({
      topic: "payment.paid",
      aggregateType: "payment",
      aggregateId: payment.id,
      payload: {
        paymentId: payment.id,
        orderId: payment.order.id,
        amount: moneyString(payment.amount),
        method: "manual_wallet",
      },
      transaction,
    });
    await recordAudit({
      actorId,
      action: "payment.manual_verify",
      resourceType: "manual_payment_claim",
      resourceId: claim.id,
      before: { status: "submitted" },
      after: {
        status: "verified",
        amount: moneyString(payment.amount),
        provider: claim.provider,
      },
      request,
      transaction,
    });
    return claimDto(claim);
  });
}

export async function rejectManualPayment(
  id: RuntimeValue,
  reason: RuntimeValue,
  actorId: RuntimeValue,
  request: RuntimeValue = null,
) {
  return sequelize.transaction(async (transaction: RuntimeValue) => {
    const claim = await lockSubmittedClaim(id, transaction);
    claim.status = "rejected";
    claim.reviewedBy = actorId;
    claim.reviewedAt = new Date();
    claim.rejectionReason = String(reason).slice(0, 500);
    claim.version += 1;
    await claim.save({ transaction });
    await OrderEvent.create(
      {
        id: newId(),
        orderId: claim.orderId,
        actorId,
        type: "manual_payment_rejected",
        message:
          "We could not verify the payment reference. You can pay on delivery or submit a new reference.",
        public: true,
        metadata: { claimId: claim.id },
      },
      { transaction },
    );
    await recordAudit({
      actorId,
      action: "payment.manual_reject",
      resourceType: "manual_payment_claim",
      resourceId: claim.id,
      before: { status: "submitted" },
      after: { status: "rejected", reason: claim.rejectionReason },
      request,
      transaction,
    });
    return claimDto(claim);
  });
}

/**
 * Claims nobody reviewed within `confirmation.maxPendingHours` expire so the
 * queue cannot grow without bound. The order stays payable on delivery.
 */
export async function expireStaleManualPayments(now = new Date()) {
  const confirmation: RuntimeValue = await settingValue("confirmation");
  const cutoff = new Date(
    now.getTime() - Number(confirmation.maxPendingHours || 48) * 3600000,
  );
  const stale: RuntimeValue[] = await ManualPaymentClaim.findAll({
    where: { status: "submitted", createdAt: { [Op.lt]: cutoff } },
    attributes: ["id"],
    limit: 100,
  });
  let expired = 0;
  for (const { id } of stale) {
    await sequelize.transaction(async (transaction: RuntimeValue) => {
      const claim: RuntimeValue = await ManualPaymentClaim.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!claim || claim.status !== "submitted") return;
      claim.status = "expired";
      claim.reviewedAt = now;
      claim.version += 1;
      await claim.save({ transaction });
      await OrderEvent.create(
        {
          id: newId(),
          orderId: claim.orderId,
          actorId: null,
          type: "manual_payment_expired",
          message:
            "We could not verify your payment reference in time. You can submit it again or pay on delivery.",
          public: true,
          metadata: { claimId: claim.id },
        },
        { transaction },
      );
      expired += 1;
    });
  }
  return expired;
}
