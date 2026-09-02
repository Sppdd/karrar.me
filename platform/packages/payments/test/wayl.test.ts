import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromDecimal } from '@vidgen/shared';
import { WaylProvider, amountToGatewayUnits } from '../src/wayl.ts';
import { PaymentConfigError, WebhookVerificationError } from '../src/types.ts';

const SECRET = 'whsec_test';
const provider = new WaylProvider({ apiKey: 'k', webhookSecret: SECRET });

const sign = (body: string, secret = SECRET): string =>
  createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ eventId: 'evt_1', referenceId: 'top_abc', status: 'paid', ...over });

describe('webhook signature verification', () => {
  it('accepts a correctly signed body', () => {
    const b = body();
    const event = provider.verifyWebhook(Buffer.from(b), { 'x-wayl-signature-256': sign(b) });
    expect(event).toMatchObject({ eventId: 'evt_1', referenceId: 'top_abc', status: 'paid' });
  });

  it('accepts the sha256= prefixed form', () => {
    const b = body();
    expect(() =>
      provider.verifyWebhook(Buffer.from(b), { 'x-wayl-signature-256': `sha256=${sign(b)}` }),
    ).not.toThrow();
  });

  it('rejects a body tampered with after signing', () => {
    const b = body();
    const sig = sign(b);
    const tampered = body({ status: 'paid', referenceId: 'top_attacker' });
    expect(() =>
      provider.verifyWebhook(Buffer.from(tampered), { 'x-wayl-signature-256': sig }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a signature made with the wrong secret', () => {
    const b = body();
    expect(() =>
      provider.verifyWebhook(Buffer.from(b), { 'x-wayl-signature-256': sign(b, 'wrong') }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a missing signature header outright', () => {
    expect(() => provider.verifyWebhook(Buffer.from(body()), {})).toThrow(/missing/);
  });

  it('rejects a malformed signature without throwing a length error', () => {
    // timingSafeEqual throws on length mismatch; the length guard must catch it
    // first so the failure is a clean verification error.
    expect(() =>
      provider.verifyWebhook(Buffer.from(body()), { 'x-wayl-signature-256': 'abcd' }),
    ).toThrow(WebhookVerificationError);
  });

  it('verifies over RAW bytes, so a re-serialized body fails', () => {
    // The classic bug: parse JSON, re-stringify, then verify. Key order and
    // whitespace change, the HMAC no longer matches, and someone "fixes" it by
    // skipping verification entirely.
    const raw = '{"referenceId":"top_abc",  "status":"paid","eventId":"evt_1"}';
    const sig = sign(raw);
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(reserialized).not.toBe(raw);
    expect(() =>
      provider.verifyWebhook(Buffer.from(reserialized), { 'x-wayl-signature-256': sig }),
    ).toThrow(WebhookVerificationError);
    // ...while the untouched bytes verify.
    expect(() =>
      provider.verifyWebhook(Buffer.from(raw), { 'x-wayl-signature-256': sig }),
    ).not.toThrow();
  });

  it('refuses to verify at all without a configured secret', () => {
    const noSecret = new WaylProvider({ apiKey: 'k', webhookSecret: '' });
    expect(() =>
      noSecret.verifyWebhook(Buffer.from(body()), { 'x-wayl-signature-256': 'x' }),
    ).toThrow(PaymentConfigError);
  });

  it('is case-insensitive about the header name', () => {
    const b = body();
    expect(() =>
      provider.verifyWebhook(Buffer.from(b), { 'X-WAYL-SIGNATURE-256': sign(b) }),
    ).not.toThrow();
  });
});

describe('status mapping', () => {
  const statusOf = (status: string) => {
    const b = body({ status });
    return provider.verifyWebhook(Buffer.from(b), { 'x-wayl-signature-256': sign(b) }).status;
  };

  it.each([
    ['paid', 'paid'], ['completed', 'paid'], ['successful', 'paid'],
    ['failed', 'failed'], ['declined', 'failed'],
    ['expired', 'expired'], ['invalidated', 'expired'],
    ['refunded', 'refunded'], ['Created', 'pending'], ['pending', 'pending'],
  ])('maps %s -> %s', (raw, expected) => {
    expect(statusOf(raw)).toBe(expected);
  });

  it('treats an unrecognised status as pending, never as paid', () => {
    // Guessing "paid" would hand out credits for nothing; the reconciliation
    // sweep resolves genuinely unknown states via getStatus instead.
    expect(statusOf('some_new_state_wayl_added')).toBe('pending');
  });
});

describe('IQD amount conversion', () => {
  it('sends whole dinars, matching the documented example', () => {
    expect(amountToGatewayUnits(fromDecimal(10_000, 'IQD'))).toBe(10_000);
  });

  it('refuses a fractional dinar rather than silently rounding', () => {
    // Rounding here would be a real loss or overcharge per transaction.
    expect(() => amountToGatewayUnits({ micros: 10_500_000n, currency: 'IQD' })).toThrow(RangeError);
  });

  it('refuses a non-IQD amount', () => {
    expect(() => amountToGatewayUnits(fromDecimal(10, 'USD'))).toThrow(/settles in IQD/);
  });
});

describe('createCharge', () => {
  it('sends referenceId as the gateway idempotency handle and returns the link', async () => {
    let captured: Record<string, unknown> = {};
    const p = new WaylProvider({
      apiKey: 'k',
      webhookSecret: SECRET,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ data: { url: 'https://pay.wayl.io/abc', paymentCode: 'PC1', status: 'Created' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const out = await p.createCharge({
      referenceId: 'top_abc',
      amount: fromDecimal(15_000, 'IQD'),
      webhookUrl: 'https://x/hook',
      redirectUrl: 'https://x/done',
    });

    expect(captured).toMatchObject({ referenceId: 'top_abc', total: 15_000, currency: 'IQD' });
    expect(out).toEqual({
      redirectUrl: 'https://pay.wayl.io/abc',
      gatewayRef: 'PC1',
      status: 'pending',
    });
  });

  it('fails with an actionable message when unconfigured', async () => {
    const p = new WaylProvider({ apiKey: '', webhookSecret: SECRET });
    await expect(
      p.createCharge({
        referenceId: 'r', amount: fromDecimal(1000, 'IQD'),
        webhookUrl: 'https://x', redirectUrl: 'https://y',
      }),
    ).rejects.toThrow(PaymentConfigError);
  });
});
