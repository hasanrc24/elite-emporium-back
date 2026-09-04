import { describe, expect, it } from 'vitest';
import { evaluateReturnWindow, refundableLineAmount } from '../../src/modules/returns/return-policy.service.js';
import { moneyString } from '../../src/lib/money.js';

describe('return policy', () => {
  it('uses the delivery instant and policy window', () => {
    const deliveredAt = new Date('2026-08-01T00:00:00.000Z');
    expect(evaluateReturnWindow({ enabled: true, windowDays: 7, fulfillmentStatus: 'delivered', deliveredAt, now: new Date('2026-08-08T00:00:00.000Z') }).eligible).toBe(true);
    expect(evaluateReturnWindow({ enabled: true, windowDays: 7, fulfillmentStatus: 'delivered', deliveredAt, now: new Date('2026-08-08T00:00:00.001Z') }).reason).toBe('RETURN_WINDOW_EXPIRED');
  });

  it('requires a delivered fulfillment state and a delivery timestamp', () => {
    expect(evaluateReturnWindow({ enabled: true, windowDays: 7, fulfillmentStatus: 'shipped', deliveredAt: new Date() }).reason).toBe('ORDER_NOT_DELIVERED');
    expect(evaluateReturnWindow({ enabled: true, windowDays: 7, fulfillmentStatus: 'delivered', deliveredAt: null }).reason).toBe('DELIVERY_DATE_UNAVAILABLE');
  });

  it('allocates a proportional line refund with decimal rounding', () => {
    expect(moneyString(refundableLineAmount({ lineTotal: '100.00', quantity: 3 }, 1))).toBe('33.33');
  });
});

