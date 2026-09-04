import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from '../../src/lib/normalization.js';

describe('Bangladeshi identity normalization', () => {
  it.each([
    ['01712-345678', '+8801712345678'],
    ['+880 1712 345678', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
  ])('normalizes %s', (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it('rejects invalid mobile numbers', () => expect(normalizePhone('0212345')).toBeNull());
  it('normalizes email casing and whitespace', () => expect(normalizeEmail(' Owner@Example.COM ')).toBe('owner@example.com'));
});
