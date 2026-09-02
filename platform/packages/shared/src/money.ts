/**
 * Money as integer micro-units. Never floats.
 *
 * Micros (1e-6 of a currency unit) rather than cents because provider pricing is
 * quoted per second at rates like $0.05/s, and a 4-second shot at draft
 * resolution lands well inside a cent. Rounding to cents per shot and then
 * summing 20 fixtures x 3 providers x 3 attempts compounds into a materially
 * wrong benchmark.
 *
 * The IQD hazard documented in docs/07-payments.md lives here too: ISO 4217
 * assigns IQD three decimal places while gateways transact in whole dinars, so
 * `currency` is always explicit and no code path assumes 100 minor units.
 */
export type Currency = 'USD' | 'IQD';

export interface Money {
  readonly micros: bigint;
  readonly currency: Currency;
}

export const money = (micros: bigint, currency: Currency): Money => ({ micros, currency });

export const usd = (micros: bigint): Money => money(micros, 'USD');

/** Build Money from a decimal amount. Only for literals and config, never arithmetic. */
export function fromDecimal(amount: number, currency: Currency): Money {
  if (!Number.isFinite(amount)) throw new RangeError(`amount not finite: ${amount}`);
  // Round rather than truncate so 0.07 * 1e6 (= 69999.99...) lands on 70000.
  return money(BigInt(Math.round(amount * 1_000_000)), currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.micros + b.micros, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce<Money>((acc, m) => add(acc, m), money(0n, currency));
}

/**
 * Scale by a rational factor, kept exact by multiplying before dividing.
 * `scale(x, 3, 2)` is x * 1.5 with no float involved.
 */
export function scale(m: Money, numerator: bigint, denominator: bigint): Money {
  if (denominator === 0n) throw new RangeError('denominator is zero');
  return money((m.micros * numerator) / denominator, m.currency);
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.micros < b.micros ? -1 : a.micros > b.micros ? 1 : 0;
}

export function toDecimalString(m: Money, places = 4): string {
  const neg = m.micros < 0n;
  const abs = neg ? -m.micros : m.micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, places);
  return `${neg ? '-' : ''}${whole}${places > 0 ? `.${frac}` : ''}`;
}

export const format = (m: Money, places = 4): string =>
  `${m.currency} ${toDecimalString(m, places)}`;

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
