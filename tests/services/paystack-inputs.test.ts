import { describe, expect, it } from 'vitest';
import { paystackSubunits, validatePaystackReference } from '@/index.ts';

describe('Paystack input conversion', () => {
  it('converts decimal strings to minor units without floating point rounding', () => {
    expect(paystackSubunits('12.30', 'NGN')).toBe('1230');
    expect(paystackSubunits('0.01', 'GHS')).toBe('1');
    expect(paystackSubunits('12', 'XOF')).toBe('1200');
    expect(paystackSubunits('9007199254740993.01', 'USD')).toBe('900719925474099301');
  });

  it('rejects zero, excess precision, malformed values, and unsupported currency', () => {
    for (const amount of ['0', '-1', '1e2', '1.001', '01', '']) {
      expect(() => paystackSubunits(amount, 'NGN')).toThrow();
    }
    expect(() => paystackSubunits('1', 'EUR')).toThrow('Unsupported Paystack currency');
    expect(() => paystackSubunits('1.00', 'XOF')).toThrow('XOF amounts must be whole numbers');
  });

  it('validates references without silently changing them', () => {
    expect(validatePaystackReference('order-1.2=3')).toBe(true);
    expect(validatePaystackReference('order_1')).toBe(false);
    expect(validatePaystackReference('')).toBe(false);
  });
});
