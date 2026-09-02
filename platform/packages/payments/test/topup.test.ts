import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBalance, getJournalBalance } from '@vidgen/db';
import { fromDecimal } from '@vidgen/shared';
import { type TestDb, inTx, makeDb } from '../../db/test/helpers.ts';
import { CREDIT_PACKS, applyWebhook, findStalePendingPayments, startTopUp } from '../src/topup.ts';
import { WaylProvider } from '../src/wayl.ts';
import type { WebhookEvent } from '../src/types.ts';

const SECRET = 'whsec_test';

function fakeGateway(overrides: { status?: string } = {}) {
  return new WaylProvider({
    apiKey: 'k',
    webhookSecret: SECRET,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: {
            url: 'https://pay.wayl.io/abc',
            paymentCode: 'PC1',
            status: overrides.status ?? 'Created',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  });
}

let db: TestDb;
beforeAll(async () => { db = await makeDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.reset(); });

const start = () =>
  startTopUp(db, fakeGateway(), {
    orgId: db.orgId,
    packId: 'standard',
    webhookUrl: 'https://x/hook',
    redirectUrl: 'https://x/done',
    fxRateMicros: 1_310_000_000n,
  });

const paidEvent = (referenceId: string, eventId = 'evt_1'): WebhookEvent => ({
  eventId,
  referenceId,
  status: 'paid',
});

describe('startTopUp', () => {
  it('creates a pending payment and a checkout link, crediting nothing yet', async () => {
    const out = await start();
    expect(out.redirectUrl).toBe('https://pay.wayl.io/abc');

    const { rows } = await db.query<{
      status: string; credits: string | number; fx_rate_micros: string | number;
    }>('SELECT status, credits, fx_rate_micros FROM payments WHERE id = $1', [out.paymentId]);

    expect(rows[0]?.status).toBe('pending');
    // int8 comes back as a string from `pg` and a number from PGlite, so
    // normalise rather than asserting one driver's representation. Application
    // code wraps these in BigInt() for the same reason.
    expect(BigInt(rows[0]!.credits)).toBe(2000n);
    // FX pinned at purchase time, per docs/07.
    expect(BigInt(rows[0]!.fx_rate_micros)).toBe(1_310_000_000n);

    // Nothing credited until a verified webhook says so.
    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
  });

  it('rejects an unknown credit pack', async () => {
    await expect(
      startTopUp(db, fakeGateway(), {
        orgId: db.orgId, packId: 'nope',
        webhookUrl: 'https://x', redirectUrl: 'https://y',
      }),
    ).rejects.toThrow(/unknown credit pack/);
  });

  it('gives every top-up a distinct reference id', async () => {
    const a = await start();
    const b = await start();
    expect(a.referenceId).not.toBe(b.referenceId);
  });
});

describe('applyWebhook', () => {
  it('credits the ledger on a paid event', async () => {
    const { paymentId, referenceId } = await start();
    const out = await inTx(db, (tx) =>
      applyWebhook(tx, 'wayl', paidEvent(referenceId), '{}', 'sig'),
    );

    expect(out).toEqual({ kind: 'credited', paymentId, credits: 2000n });
    expect(await getBalance(db, db.orgId)).toEqual({ available: 2000n, reserved: 0n });
    expect(await getJournalBalance(db, db.orgId)).toEqual({ available: 2000n, reserved: 0n });
  });

  it('is a no-op on redelivery of the same event', async () => {
    const { referenceId } = await start();
    await inTx(db, (tx) => applyWebhook(tx, 'wayl', paidEvent(referenceId), '{}'));
    const second = await inTx(db, (tx) => applyWebhook(tx, 'wayl', paidEvent(referenceId), '{}'));

    expect(second.kind).toBe('duplicate');
    expect(await getBalance(db, db.orgId)).toEqual({ available: 2000n, reserved: 0n });
  });

  it('does not double-credit when the gateway sends a NEW event id for the same payment', async () => {
    // Belt and braces: the (gateway, event_id) index cannot help here, so the
    // ledger's own idempotency key on payment:<id> has to catch it.
    const { referenceId } = await start();
    await inTx(db, (tx) => applyWebhook(tx, 'wayl', paidEvent(referenceId, 'evt_1'), '{}'));
    const second = await inTx(db, (tx) =>
      applyWebhook(tx, 'wayl', paidEvent(referenceId, 'evt_2'), '{}'),
    );

    expect(second.kind).toBe('duplicate');
    expect(await getBalance(db, db.orgId)).toEqual({ available: 2000n, reserved: 0n });
  });

  it('credits nothing for a failed event and records the status', async () => {
    const { paymentId, referenceId } = await start();
    const out = await inTx(db, (tx) =>
      applyWebhook(tx, 'wayl', { eventId: 'e', referenceId, status: 'failed' }, '{}'),
    );

    expect(out.kind).toBe('ignored');
    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1', [paymentId],
    );
    expect(rows[0]?.status).toBe('failed');
  });

  it('credits nothing for a pending event', async () => {
    const { referenceId } = await start();
    const out = await inTx(db, (tx) =>
      applyWebhook(tx, 'wayl', { eventId: 'e', referenceId, status: 'pending' }, '{}'),
    );
    expect(out.kind).toBe('ignored');
    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
  });

  it('ignores an event for a reference it has never seen', async () => {
    const out = await inTx(db, (tx) =>
      applyWebhook(tx, 'wayl', paidEvent('top_does_not_exist'), '{}'),
    );
    expect(out).toMatchObject({ kind: 'ignored' });
    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
  });

  it('retains the raw body, because a disputed payment is argued from bytes', async () => {
    const { referenceId } = await start();
    const raw = '{"referenceId":"x","status":"paid"}';
    await inTx(db, (tx) => applyWebhook(tx, 'wayl', paidEvent(referenceId), raw, 'sig123'));

    const { rows } = await db.query<{ raw_body: string; signature: string; processed_at: string }>(
      'SELECT raw_body, signature, processed_at FROM payment_webhook_events',
    );
    expect(rows[0]?.raw_body).toBe(raw);
    expect(rows[0]?.signature).toBe('sig123');
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  it('leaves no partial state when the transaction rolls back', async () => {
    const { referenceId } = await start();
    await inTx(db, async (tx) => {
      await applyWebhook(tx, 'wayl', paidEvent(referenceId), '{}');
      throw new Error('boom');
    }).catch(() => {});

    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
    const { rows } = await db.query('SELECT * FROM payment_webhook_events');
    expect(rows).toEqual([]);
  });
});

describe('the redirect must never credit', () => {
  it('exposes no function that credits from a redirect return', async () => {
    // The browser's return to redirectUrl is forgeable by visiting the success
    // URL. The absence of such an entry point IS the safeguard, so this test
    // guards the module surface rather than a behaviour.
    const mod = await import('../src/topup.ts');
    const names = Object.keys(mod).map((n) => n.toLowerCase());
    expect(names.some((n) => n.includes('redirect') || n.includes('return'))).toBe(false);
    expect(Object.keys(mod).sort()).toEqual([
      'CREDIT_PACKS', 'applyWebhook', 'findPack', 'findStalePendingPayments', 'startTopUp',
    ]);
  });
});

describe('reconciliation sweep', () => {
  it('finds payments left pending past the threshold', async () => {
    const { paymentId } = await start();
    await db.query(
      `UPDATE payments SET created_at = now() - interval '30 minutes' WHERE id = $1`,
      [paymentId],
    );
    const stale = await findStalePendingPayments(db, 15);
    expect(stale.map((p) => p.id)).toEqual([paymentId]);
  });

  it('leaves recent and already-paid payments alone', async () => {
    await start(); // recent, still pending
    const { paymentId, referenceId } = await start();
    await db.query(
      `UPDATE payments SET created_at = now() - interval '30 minutes' WHERE id = $1`,
      [paymentId],
    );
    await inTx(db, (tx) => applyWebhook(tx, 'wayl', paidEvent(referenceId), '{}'));

    expect(await findStalePendingPayments(db, 15)).toEqual([]);
  });
});

describe('credit packs', () => {
  it('are all positive and priced in IQD', () => {
    for (const p of CREDIT_PACKS) {
      expect(p.credits).toBeGreaterThan(0n);
      expect(p.price.currency).toBe('IQD');
      // Whole dinars: the gateway rejects fractions.
      expect(p.price.micros % 1_000_000n).toBe(0n);
    }
  });

  it('has unique ids', () => {
    expect(new Set(CREDIT_PACKS.map((p) => p.id)).size).toBe(CREDIT_PACKS.length);
  });
});

describe('signature-to-ledger path', () => {
  it('only credits after verifyWebhook accepts the raw bytes', async () => {
    const { referenceId } = await start();
    const gateway = fakeGateway();
    const raw = JSON.stringify({ eventId: 'evt_9', referenceId, status: 'paid' });
    const sig = createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex');

    const event = gateway.verifyWebhook(Buffer.from(raw), { 'x-wayl-signature-256': sig });
    const out = await inTx(db, (tx) => applyWebhook(tx, gateway.id, event, raw, sig));

    expect(out.kind).toBe('credited');
    expect((await getBalance(db, db.orgId)).available).toBe(2000n);
  });
});
