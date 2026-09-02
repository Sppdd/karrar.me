import { randomUUID } from 'node:crypto';
import { type Queryable, topUp } from '@vidgen/db';
import { type Money, fromDecimal } from '@vidgen/shared';
import type { PaymentProvider, WebhookEvent } from './types.ts';

/**
 * The top-up write path: gateway payment in, credits out.
 *
 * THE RULE THAT MUST NOT BREAK: the ledger is credited ONLY from a
 * signature-verified webhook or an authoritative getStatus() pull. Never from
 * the browser's return to redirectUrl - that is a UX hint, not proof of
 * payment, and is forgeable by simply visiting the success URL.
 *
 * There is deliberately no function in this module that takes a redirect
 * callback and credits the ledger. The absence is the safeguard.
 */

export interface CreditPack {
  readonly id: string;
  readonly credits: bigint;
  /** Price in IQD. */
  readonly price: Money;
}

/**
 * Placeholder catalogue. Real pricing is blocked on Phase 0: until the
 * benchmark has measured cost per acceptable shot, any credit price is a guess.
 */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'starter', credits: 500n, price: fromDecimal(15_000, 'IQD') },
  { id: 'standard', credits: 2_000n, price: fromDecimal(50_000, 'IQD') },
  { id: 'studio', credits: 5_000n, price: fromDecimal(110_000, 'IQD') },
];

export const findPack = (id: string): CreditPack | undefined =>
  CREDIT_PACKS.find((p) => p.id === id);

export interface StartTopUpInput {
  readonly orgId: string;
  readonly userId?: string;
  readonly packId: string;
  readonly webhookUrl: string;
  readonly redirectUrl: string;
  /** Micros of IQD per 1 USD at purchase time; pinned onto the payment row. */
  readonly fxRateMicros?: bigint;
}

export interface StartedTopUp {
  readonly paymentId: string;
  readonly referenceId: string;
  readonly redirectUrl: string;
}

/**
 * Creates the pending payment row and the gateway checkout link.
 *
 * The FX rate is pinned HERE, at purchase time: revenue is IQD and provider
 * costs are USD, so drift between purchase and spend is absorbed by the margin
 * buffer rather than repriced at a user mid-project (docs/07).
 */
export async function startTopUp(
  db: Queryable,
  gateway: PaymentProvider,
  input: StartTopUpInput,
): Promise<StartedTopUp> {
  const pack = findPack(input.packId);
  if (!pack) throw new Error(`unknown credit pack "${input.packId}"`);

  const referenceId = `top_${randomUUID().replace(/-/g, '')}`;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (org_id, user_id, gateway, reference_id, amount_minor, currency,
        credits, fx_rate_micros, fx_quote_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.orgId,
      input.userId ?? null,
      gateway.id,
      referenceId,
      pack.price.micros.toString(),
      pack.price.currency,
      pack.credits.toString(),
      input.fxRateMicros?.toString() ?? null,
      input.fxRateMicros ? 'USD' : null,
    ],
  );
  const paymentId = rows[0]?.id;
  if (!paymentId) throw new Error('failed to create payment row');

  const charge = await gateway.createCharge({
    referenceId,
    amount: pack.price,
    description: `${pack.credits} credits`,
    webhookUrl: input.webhookUrl,
    redirectUrl: input.redirectUrl,
  });

  await db.query(
    `UPDATE payments SET gateway_ref = $2, checkout_url = $3 WHERE id = $1`,
    [paymentId, charge.gatewayRef, charge.redirectUrl],
  );

  return { paymentId, referenceId, redirectUrl: charge.redirectUrl };
}

export type WebhookOutcome =
  | { readonly kind: 'credited'; readonly paymentId: string; readonly credits: bigint }
  | { readonly kind: 'duplicate'; readonly reason: string }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * Applies a VERIFIED webhook event. Caller must have run
 * `gateway.verifyWebhook` first - this function trusts its input.
 *
 * Must run inside a transaction: the event record, the payment update and the
 * ledger credit have to land together or not at all.
 *
 * Webhooks are at-least-once and can arrive out of order, so this is idempotent
 * at two levels - the unique index on (gateway, event_id) here, and the ledger's
 * own idempotency key. Either alone would do; both means a gateway that omits a
 * stable event id still cannot double-credit.
 */
export async function applyWebhook(
  tx: Queryable,
  gatewayId: string,
  event: WebhookEvent,
  rawBody: string,
  signature?: string,
): Promise<WebhookOutcome> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO payment_webhook_events (gateway, event_id, reference_id, status, raw_body, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (gateway, event_id) DO NOTHING
     RETURNING id`,
    [gatewayId, event.eventId, event.referenceId, event.status, rawBody, signature ?? null],
  );
  if (!inserted.rows[0]) {
    return { kind: 'duplicate', reason: `event ${event.eventId} already processed` };
  }
  const eventRowId = inserted.rows[0].id;

  const { rows } = await tx.query<{
    id: string;
    org_id: string;
    credits: string;
    status: string;
  }>(
    `SELECT id, org_id, credits, status FROM payments
      WHERE gateway = $1 AND reference_id = $2 FOR UPDATE`,
    [gatewayId, event.referenceId],
  );
  const payment = rows[0];
  if (!payment) {
    return { kind: 'ignored', reason: `no payment for reference ${event.referenceId}` };
  }

  await tx.query(`UPDATE payment_webhook_events SET payment_id = $2 WHERE id = $1`, [
    eventRowId,
    payment.id,
  ]);

  if (event.status !== 'paid') {
    await tx.query(`UPDATE payments SET status = $2 WHERE id = $1`, [payment.id, event.status]);
    return { kind: 'ignored', reason: `status ${event.status} is not a credit event` };
  }

  // A late duplicate 'paid' for an already-settled payment must not credit again.
  if (payment.status === 'paid') {
    return { kind: 'duplicate', reason: `payment ${payment.id} already paid` };
  }

  const credits = BigInt(payment.credits);
  await topUp(tx, {
    orgId: payment.org_id,
    credits,
    paymentId: payment.id,
    // Ties the ledger entry to this payment, so even a gateway that reuses or
    // omits event ids cannot produce a second credit.
    idempotencyKey: `payment:${payment.id}`,
  });

  await tx.query(`UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1`, [
    payment.id,
  ]);

  await tx.query(`UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1`, [
    eventRowId,
  ]);

  return { kind: 'credited', paymentId: payment.id, credits };
}

/**
 * Payments still pending past `olderThanMinutes`, for the reconciliation sweep.
 *
 * A dropped webhook must not strand a payment the customer actually made, so
 * the sweep pulls authoritative status from the gateway rather than waiting.
 */
export async function findStalePendingPayments(
  db: Queryable,
  olderThanMinutes = 15,
): Promise<{ id: string; reference_id: string }[]> {
  const { rows } = await db.query<{ id: string; reference_id: string }>(
    `SELECT id, reference_id FROM payments
      WHERE status = 'pending'
        AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at`,
    [olderThanMinutes],
  );
  return rows;
}
