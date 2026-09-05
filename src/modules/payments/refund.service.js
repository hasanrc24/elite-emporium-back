import { Op } from 'sequelize';
import {
  IdempotencyRecord,
  Order,
  OrderEvent,
  Payment,
  PaymentAttempt,
  Refund,
  ReturnRequest,
  User,
} from '../../db/models.js';
import { sequelize } from '../../db/sequelize.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { money, moneyString } from '../../lib/money.js';
import { dateRangeWhere } from '../../lib/date-range.js';
import { pagination, pageEnvelope } from '../../lib/pagination.js';
import { recordAudit } from '../audits/audit.service.js';
import { addDomainEvent, queueNotification } from '../events/outbox.service.js';
import {
  BkashProviderError,
  queryBkashRefund,
  redactBkashPayload,
  refundBkashPayment,
} from './bkash.adapter.js';
import { calculatePaymentRefundCapacity } from './refund.math.js';

const refundInclude = [
  { model: Payment, as: 'payment', include: [{ model: Order, as: 'order' }] },
  { model: ReturnRequest, as: 'return', required: false },
  { model: User, as: 'actor', attributes: ['id', 'name'] },
];

function normalizedProviderRefund(body) {
  return {
    refundTransactionId: body.refundTrxID || body.refundTrxId || body.refundTransactionId || null,
    originalTransactionId: body.originalTrxID || body.originalTrxId || body.originalTransactionId || null,
    status: body.transactionStatus || body.refundTransactionStatus || body.refundStatus || null,
    amount: body.amount ?? body.refundAmount ?? null,
    currency: body.currency || null,
    completedAt: body.completedTime || body.refundExecuteTime || null,
    raw: redactBkashPayload(body),
  };
}

function providerPaymentId(payment) {
  const successful = payment.attempts?.find((attempt) => attempt.status === 'succeeded' && attempt.providerPaymentId);
  return successful?.providerPaymentId || payment.metadata?.providerPaymentId || null;
}

export function refundDto(refund, paymentCapacity = null) {
  const payment = refund.payment;
  const order = payment?.order;
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    order: order ? { id: order.id, reference: order.reference } : null,
    return: refund.return ? { id: refund.return.id, reference: refund.return.reference, status: refund.return.status } : null,
    amount: moneyString(refund.amount),
    currency: payment?.currency || 'BDT',
    reason: refund.reason,
    method: refund.method,
    status: refund.status,
    providerRefundId: refund.providerRefundId || null,
    actor: refund.actor || null,
    completedAt: refund.completedAt,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
    ...(paymentCapacity ? { paymentCapacity } : {}),
    diagnostics: {
      reconciliationRequired: Boolean(refund.metadata?.reconciliationRequired),
      lastProviderCode: refund.metadata?.lastProviderCode || null,
      lastCheckedAt: refund.metadata?.lastCheckedAt || null,
    },
  };
}

async function lockedRefundRows(paymentId, transaction) {
  return Refund.findAll({
    where: { paymentId },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
}

function paymentCapacity(payment, rows) {
  return calculatePaymentRefundCapacity(payment.amount, rows);
}

async function getRefundWithinTransaction(id, transaction) {
  return Refund.findByPk(id, { include: refundInclude, transaction });
}

export async function listRefunds(query) {
  const { page, pageSize, limit, offset } = pagination(query);
  const where = {};
  if (query.status) where.status = query.status;
  if (query.method) where.method = query.method;
  if (query.paymentId) where.paymentId = query.paymentId;
  if (query.returnId) where.returnId = query.returnId;
  Object.assign(where, dateRangeWhere(query));
  const orderWhere = query.search ? {
    [Op.or]: [
      { reference: { [Op.like]: `%${String(query.search).slice(0, 80)}%` } },
      { customerPhone: { [Op.like]: `%${String(query.search).slice(0, 30)}%` } },
    ],
  } : undefined;
  const result = await Refund.findAndCountAll({
    where,
    include: [
      { model: Payment, as: 'payment', include: [{ model: Order, as: 'order', where: orderWhere }] },
      { model: ReturnRequest, as: 'return', required: false },
      { model: User, as: 'actor', attributes: ['id', 'name'] },
    ],
    distinct: true,
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });
  return { data: result.rows.map((row) => refundDto(row)), meta: pageEnvelope(result, page, pageSize).meta };
}

export async function getRefund(id) {
  const refund = await Refund.findByPk(id, { include: refundInclude });
  if (!refund) throw AppError.notFound('Refund not found.');
  const rows = await Refund.findAll({ where: { paymentId: refund.paymentId } });
  return refundDto(refund, paymentCapacity(refund.payment, rows));
}

export async function getPaymentRefundCapacity(paymentId) {
  const payment = await Payment.findByPk(paymentId, {
    include: [{ model: Order, as: 'order' }, { model: PaymentAttempt, as: 'attempts' }],
  });
  if (!payment) throw AppError.notFound('Payment not found.');
  const rows = await Refund.findAll({ where: { paymentId } });
  return {
    paymentId: payment.id,
    order: { id: payment.order.id, reference: payment.order.reference },
    method: payment.method,
    status: payment.status,
    providerTransactionId: payment.providerTransactionId || null,
    providerPaymentId: providerPaymentId(payment),
    ...paymentCapacity(payment, rows),
  };
}

async function createRefundIntent(paymentId, payload, actorId, idempotencyKey, request) {
  if (!idempotencyKey) throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
  const requestHash = sha256(canonicalJson({ paymentId, ...payload }));
  return sequelize.transaction(async (transaction) => {
    const [idempotency] = await IdempotencyRecord.findOrCreate({
      where: { scope: 'payments.refund', key: idempotencyKey, actorKey: actorId },
      defaults: {
        id: newId(),
        scope: 'payments.refund',
        key: idempotencyKey,
        actorKey: actorId,
        requestHash,
        expiresAt: new Date(Date.now() + 3650 * 86400000),
      },
      transaction,
    });
    await idempotency.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (idempotency.requestHash !== requestHash) throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'This refund key was already used for a different request.');
    if (idempotency.responseBody?.refundId) {
      return { refundId: idempotency.responseBody.refundId, invokeProvider: false, replay: true };
    }

    const payment = await Payment.findByPk(paymentId, {
      include: [{ model: Order, as: 'order' }, { model: PaymentAttempt, as: 'attempts' }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment) throw AppError.notFound('Payment not found.');
    if (!['paid', 'partially_refunded'].includes(payment.status)) throw AppError.conflict('PAYMENT_NOT_REFUNDABLE', 'Only a captured or collected payment can be refunded.');
    if (payload.method === 'bkash' && (payment.method !== 'bkash' || !payment.providerTransactionId || !providerPaymentId(payment))) {
      throw AppError.unprocessable('BKASH_REFUND_UNAVAILABLE', 'This payment does not have the verified bKash identifiers required for a provider refund.');
    }

    const refunds = await lockedRefundRows(payment.id, transaction);
    const capacity = paymentCapacity(payment, refunds);
    const amount = money(payload.amount);
    if (!amount.greaterThan(0)) throw AppError.unprocessable('INVALID_REFUND_AMOUNT', 'Refund amount must be greater than zero.');
    if (amount.greaterThan(capacity.maximumRefundable)) {
      throw AppError.unprocessable('REFUND_LIMIT_EXCEEDED', `The maximum refundable amount is ${capacity.maximumRefundable}.`, { amount: [`Enter ${capacity.maximumRefundable} or less.`] });
    }

    let linkedReturn = null;
    if (payload.returnId) {
      linkedReturn = await ReturnRequest.findByPk(payload.returnId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!linkedReturn || linkedReturn.orderId !== payment.orderId) throw AppError.unprocessable('RETURN_PAYMENT_MISMATCH', 'The return request does not belong to this payment order.');
      if (linkedReturn.resolution !== 'refund' || linkedReturn.status !== 'received') throw AppError.conflict('RETURN_NOT_REFUNDABLE', 'The return must be received with refund resolution before issuing its refund.');
      if (linkedReturn.refundAmount == null || !amount.equals(linkedReturn.refundAmount)) throw AppError.unprocessable('RETURN_REFUND_AMOUNT_MISMATCH', `Refund amount must equal the approved return amount of ${moneyString(linkedReturn.refundAmount)}.`);
      const existing = await Refund.findOne({ where: { returnId: linkedReturn.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing) throw AppError.conflict('RETURN_REFUND_EXISTS', 'This return request already has a refund record.');
    }

    const refund = await Refund.create({
      id: newId(),
      paymentId: payment.id,
      orderId: payment.orderId,
      returnId: linkedReturn?.id || null,
      amount: moneyString(amount),
      reason: payload.reason,
      method: payload.method,
      status: payload.method === 'bkash' ? 'processing' : 'pending',
      actorId,
      idempotencyKey,
      metadata: {
        requestHash,
        note: payload.note || null,
        providerPaymentId: payload.method === 'bkash' ? providerPaymentId(payment) : null,
        originalTransactionId: payment.providerTransactionId || null,
        sku: payload.sku || 'ORDER',
      },
    }, { transaction });

    idempotency.responseStatus = 201;
    idempotency.responseBody = { refundId: refund.id };
    await idempotency.save({ transaction });
    await OrderEvent.create({
      id: newId(),
      orderId: payment.orderId,
      actorId,
      type: 'refund_requested',
      message: `${payload.method === 'bkash' ? 'bKash' : 'Manual'} refund requested for BDT ${moneyString(amount)}.`,
      public: true,
      metadata: { refundId: refund.id, returnId: linkedReturn?.id || null },
    }, { transaction });
    await recordAudit({
      actorId,
      action: 'payment.refund_create',
      resourceType: 'refund',
      resourceId: refund.id,
      after: { paymentId: payment.id, orderId: payment.orderId, returnId: linkedReturn?.id || null, amount: moneyString(amount), method: payload.method, status: refund.status },
      metadata: { idempotencyKey },
      request,
      transaction,
    });
    return { refundId: refund.id, invokeProvider: payload.method === 'bkash', replay: false };
  });
}

async function markProviderFailure(refundId, error, request = null) {
  return sequelize.transaction(async (transaction) => {
    const refund = await Refund.findByPk(refundId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!refund || refund.status === 'completed') return;
    const before = { status: refund.status };
    refund.status = error.uncertain ? 'processing' : 'failed';
    refund.metadata = {
      ...refund.metadata,
      reconciliationRequired: Boolean(error.uncertain),
      lastProviderCode: error.code,
      lastProviderError: error.message.slice(0, 300),
      lastCheckedAt: new Date().toISOString(),
    };
    await refund.save({ transaction });
    await recordAudit({
      action: error.uncertain ? 'payment.refund_provider_uncertain' : 'payment.refund_provider_failed',
      resourceType: 'refund',
      resourceId: refund.id,
      before,
      after: { status: refund.status, providerCode: error.code },
      request,
      transaction,
    });
  });
}

async function completeRefund(refundId, providerResult, actorId = null, request = null) {
  return sequelize.transaction(async (transaction) => {
    const refund = await Refund.findByPk(refundId, { include: refundInclude, transaction, lock: transaction.LOCK.UPDATE });
    if (!refund) throw AppError.notFound('Refund not found.');
    if (refund.status === 'completed') return refundDto(refund);
    if (!['pending', 'processing'].includes(refund.status)) throw AppError.conflict('REFUND_NOT_COMPLETABLE', 'This refund cannot be completed from its current state.');

    const payment = await Payment.findByPk(refund.paymentId, { include: [{ model: Order, as: 'order' }], transaction, lock: transaction.LOCK.UPDATE });
    const rows = await lockedRefundRows(payment.id, transaction);
    const completedBefore = rows
      .filter((row) => row.id !== refund.id && row.status === 'completed')
      .reduce((sum, row) => sum.plus(row.amount), money(0));
    if (completedBefore.plus(refund.amount).greaterThan(payment.amount)) throw AppError.conflict('REFUND_LIMIT_EXCEEDED', 'Completing this refund would exceed the captured payment amount.');

    const before = { refundStatus: refund.status, paymentStatus: payment.status, orderPaymentStatus: payment.order.paymentStatus };
    if (providerResult.providerRefundId) {
      const duplicate = await Refund.findOne({ where: { providerRefundId: providerResult.providerRefundId, id: { [Op.ne]: refund.id } }, transaction, lock: transaction.LOCK.UPDATE });
      if (duplicate) throw AppError.conflict('PROVIDER_REFUND_REUSED', 'This provider refund transaction is already linked to another refund.');
    }
    const providerCompletedAt = providerResult.completedAt ? new Date(providerResult.completedAt) : null;
    refund.status = 'completed';
    refund.completedAt = providerCompletedAt && !Number.isNaN(providerCompletedAt.getTime()) ? providerCompletedAt : new Date();
    refund.providerRefundId = providerResult.providerRefundId || refund.providerRefundId || null;
    refund.metadata = {
      ...refund.metadata,
      reconciliationRequired: false,
      lastProviderCode: providerResult.providerCode || null,
      lastCheckedAt: new Date().toISOString(),
      providerResponse: providerResult.providerResponse || refund.metadata?.providerResponse || null,
      manualReference: providerResult.manualReference || refund.metadata?.manualReference || null,
      completionNote: providerResult.note || null,
    };
    await refund.save({ transaction });

    const completedTotal = completedBefore.plus(refund.amount);
    const nextStatus = completedTotal.equals(payment.amount) ? 'refunded' : 'partially_refunded';
    payment.status = nextStatus;
    payment.version += 1;
    await payment.save({ transaction });
    payment.order.paymentStatus = nextStatus;
    payment.order.version += 1;
    await payment.order.save({ transaction });

    await OrderEvent.create({
      id: newId(),
      orderId: payment.orderId,
      actorId,
      type: 'refund_completed',
      message: `Refund of BDT ${moneyString(refund.amount)} completed.`,
      public: true,
      metadata: { refundId: refund.id, returnId: refund.returnId || null, method: refund.method },
    }, { transaction });
    await addDomainEvent({
      topic: 'payment.refunded',
      aggregateType: 'refund',
      aggregateId: refund.id,
      payload: { refundId: refund.id, paymentId: payment.id, orderId: payment.orderId, returnId: refund.returnId || null, amount: moneyString(refund.amount), currency: payment.currency, method: refund.method, paymentStatus: nextStatus },
      transaction,
    });
    if (payment.order.customerEmail || payment.order.customerPhone) {
      await queueNotification({
        event: 'payment.refunded',
        channel: payment.order.customerEmail ? 'email' : 'sms',
        locale: payment.order.locale,
        recipient: payment.order.customerEmail || payment.order.customerPhone,
        payload: { message: `A refund of BDT ${moneyString(refund.amount)} for order ${payment.order.reference} was completed.`, orderReference: payment.order.reference, amount: moneyString(refund.amount) },
        transaction,
      });
    }
    await recordAudit({
      actorId,
      action: 'payment.refund_complete',
      resourceType: 'refund',
      resourceId: refund.id,
      before,
      after: { refundStatus: refund.status, paymentStatus: nextStatus, providerRefundId: refund.providerRefundId },
      request,
      transaction,
    });
    return refundDto(await getRefundWithinTransaction(refund.id, transaction));
  });
}

function assertProviderRefund(refund, providerBody) {
  const result = normalizedProviderRefund(providerBody);
  const expectedOriginal = refund.payment.providerTransactionId;
  if (result.originalTransactionId && result.originalTransactionId !== expectedOriginal) throw new BkashProviderError('BKASH_REFUND_TRANSACTION_MISMATCH', 'bKash returned a different original transaction ID.', { uncertain: true });
  if (result.amount == null || !money(result.amount).equals(refund.amount)) throw new BkashProviderError('BKASH_REFUND_AMOUNT_MISMATCH', 'bKash returned a different refund amount.', { uncertain: true });
  if (result.currency && result.currency !== refund.payment.currency) throw new BkashProviderError('BKASH_REFUND_CURRENCY_MISMATCH', 'bKash returned a different refund currency.', { uncertain: true });
  if (!result.refundTransactionId) throw new BkashProviderError('BKASH_REFUND_ID_MISSING', 'bKash did not return a refund transaction ID.', { uncertain: true });
  return result;
}

async function executeProviderRefund(refundId, request = null) {
  const refund = await Refund.findByPk(refundId, {
    include: [{ model: Payment, as: 'payment', include: [{ model: Order, as: 'order' }] }],
  });
  if (!refund) throw AppError.notFound('Refund not found.');
  if (refund.status === 'completed') return getRefund(refund.id);
  if (refund.status !== 'processing') return getRefund(refund.id);
  try {
    const body = await refundBkashPayment({
      paymentId: refund.metadata.providerPaymentId,
      transactionId: refund.payment.providerTransactionId,
      amount: moneyString(refund.amount),
      sku: refund.metadata.sku,
      reason: refund.reason,
    });
    const result = assertProviderRefund(refund, body);
    if (!['Completed', 'Success', 'Successful'].includes(result.status)) {
      await markProviderFailure(refund.id, new BkashProviderError('BKASH_REFUND_NOT_COMPLETED', 'bKash has not completed the refund.', { uncertain: true }), request);
      return getRefund(refund.id);
    }
    return completeRefund(refund.id, {
      providerRefundId: result.refundTransactionId,
      completedAt: result.completedAt,
      providerCode: body.statusCode || null,
      providerResponse: result.raw,
    }, null, request);
  } catch (error) {
    const providerError = error instanceof BkashProviderError
      ? error
      : new BkashProviderError('BKASH_REFUND_FAILED', 'The bKash refund request failed.', { retryable: true, uncertain: true });
    await markProviderFailure(refund.id, providerError, request);
    if (!providerError.uncertain) throw new AppError(providerError.retryable ? 503 : 422, providerError.code, providerError.message);
    return getRefund(refund.id);
  }
}

export async function createRefund(paymentId, payload, actorId, idempotencyKey, request) {
  const intent = await createRefundIntent(paymentId, payload, actorId, idempotencyKey, request);
  if (intent.replay || !intent.invokeProvider) return getRefund(intent.refundId);
  return executeProviderRefund(intent.refundId, request);
}

export async function completeManualRefund(id, payload, actorId, request) {
  const refund = await Refund.findByPk(id);
  if (!refund) throw AppError.notFound('Refund not found.');
  if (refund.method !== 'manual') throw AppError.conflict('MANUAL_COMPLETION_NOT_ALLOWED', 'Only a manual refund can use this completion action.');
  return completeRefund(id, {
    completedAt: payload.completedAt || null,
    manualReference: payload.reference,
    note: payload.note || null,
  }, actorId, request);
}

export async function cancelRefund(id, reason, actorId, request) {
  return sequelize.transaction(async (transaction) => {
    const refund = await Refund.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!refund) throw AppError.notFound('Refund not found.');
    if (refund.status === 'cancelled') return refundDto(await getRefundWithinTransaction(id, transaction));
    if (refund.status !== 'pending') throw AppError.conflict('REFUND_NOT_CANCELLABLE', 'Only a pending manual refund can be cancelled.');
    const before = { status: refund.status };
    refund.status = 'cancelled';
    refund.metadata = { ...refund.metadata, cancellationReason: reason, cancelledAt: new Date().toISOString() };
    await refund.save({ transaction });
    await recordAudit({ actorId, action: 'payment.refund_cancel', resourceType: 'refund', resourceId: refund.id, before, after: { status: 'cancelled', reason }, request, transaction });
    return refundDto(await getRefundWithinTransaction(id, transaction));
  });
}

export async function reconcileBkashRefund(id, actorId, request) {
  const refund = await Refund.findByPk(id, {
    include: [{ model: Payment, as: 'payment', include: [{ model: Order, as: 'order' }] }],
  });
  if (!refund) throw AppError.notFound('Refund not found.');
  if (refund.method !== 'bkash') throw AppError.conflict('REFUND_RECONCILIATION_NOT_ALLOWED', 'Only bKash refunds can be reconciled with bKash.');
  if (refund.status === 'completed') return getRefund(refund.id);
  if (refund.status !== 'processing') throw AppError.conflict('REFUND_NOT_RECONCILABLE', 'This refund is not awaiting provider reconciliation.');
  try {
    const body = await queryBkashRefund({
      paymentId: refund.metadata.providerPaymentId,
      transactionId: refund.payment.providerTransactionId,
    });
    const result = assertProviderRefund(refund, body);
    if (['Completed', 'Success', 'Successful'].includes(result.status)) {
      return completeRefund(refund.id, {
        providerRefundId: result.refundTransactionId,
        completedAt: result.completedAt,
        providerCode: body.statusCode || null,
        providerResponse: result.raw,
      }, actorId, request);
    }
    const code = ['Failed', 'Cancelled', 'Canceled'].includes(result.status) ? 'BKASH_REFUND_FAILED' : 'BKASH_REFUND_PENDING';
    await markProviderFailure(refund.id, new BkashProviderError(code, `bKash refund status is ${result.status || 'unknown'}.`, { uncertain: code === 'BKASH_REFUND_PENDING' }), request);
    return getRefund(refund.id);
  } catch (error) {
    const providerError = error instanceof BkashProviderError ? error : new BkashProviderError('BKASH_REFUND_QUERY_FAILED', 'The bKash refund status could not be checked.', { retryable: true, uncertain: true });
    await markProviderFailure(refund.id, providerError, request);
    if (!providerError.uncertain) throw new AppError(providerError.retryable ? 503 : 422, providerError.code, providerError.message);
    return getRefund(refund.id);
  }
}
