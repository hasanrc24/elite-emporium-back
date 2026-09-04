import { describe, expect, it } from 'vitest';
import { calculatePaymentRefundCapacity } from '../../src/modules/payments/refund.math.js';

describe('refund capacity', () => {
  it('reserves pending and processing amounts against the captured payment', () => {
    expect(calculatePaymentRefundCapacity('1000.00', [
      { amount: '100.00', status: 'completed' },
      { amount: '125.50', status: 'processing' },
      { amount: '24.50', status: 'pending' },
      { amount: '900.00', status: 'failed' },
    ])).toEqual({ captured: '1000.00', completed: '100.00', committed: '250.00', maximumRefundable: '750.00' });
  });

  it('never exposes a negative refundable amount when legacy data is inconsistent', () => {
    expect(calculatePaymentRefundCapacity('100.00', [{ amount: '101.00', status: 'completed' }]).maximumRefundable).toBe('0.00');
  });
});

