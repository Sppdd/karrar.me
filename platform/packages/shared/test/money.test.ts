import { describe, expect, it } from 'vitest';
import { add, compare, format, fromDecimal, money, scale, sum, toDecimalString, usd } from '../src/money.ts';

describe('money', () => {
  it('builds from decimals without float drift', () => {
    // 0.07 * 1e6 is 69999.99... in IEEE754; truncation would lose a micro.
    expect(fromDecimal(0.07, 'USD').micros).toBe(70_000n);
    expect(fromDecimal(0.4, 'USD').micros).toBe(400_000n);
    expect(fromDecimal(0.05, 'USD').micros).toBe(50_000n);
  });

  it('rejects non-finite amounts', () => {
    expect(() => fromDecimal(Number.NaN, 'USD')).toThrow(RangeError);
    expect(() => fromDecimal(Number.POSITIVE_INFINITY, 'USD')).toThrow(RangeError);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(usd(1n), money(1n, 'IQD'))).toThrow(TypeError);
    expect(() => compare(usd(1n), money(1n, 'IQD'))).toThrow(TypeError);
  });

  it('scales exactly, multiplying before dividing', () => {
    expect(scale(usd(1_000_000n), 3n, 2n).micros).toBe(1_500_000n);
    // 1/3 of a micro-dollar stays exact rather than becoming 0.333...
    expect(scale(usd(10n), 1n, 3n).micros).toBe(3n);
    expect(() => scale(usd(10n), 1n, 0n)).toThrow(RangeError);
  });

  it('sums an empty list to zero of the stated currency', () => {
    expect(sum([], 'IQD')).toEqual({ micros: 0n, currency: 'IQD' });
  });

  it('formats without losing the currency', () => {
    expect(toDecimalString(usd(1_500_000n), 2)).toBe('1.50');
    expect(toDecimalString(usd(-1_500_000n), 2)).toBe('-1.50');
    expect(format(usd(400_000n))).toBe('USD 0.4000');
    // IQD is never assumed to have 2 minor places - see docs/07.
    expect(format(money(1_000_000n, 'IQD'), 0)).toBe('IQD 1');
  });
});
