import { describe, expect, it } from 'vitest';
import { lineTotal, moneyString } from '../../src/lib/money.js';

describe('money helpers', () => {
  it('uses decimal arithmetic for order lines', () => expect(moneyString(lineTotal('1690.50', 3))).toBe('5071.50'));
  it('always serializes two decimal places', () => expect(moneyString('80')).toBe('80.00'));
});
