import { randomUUID } from 'node:crypto';
import { type Queryable, UNIQUE_VIOLATION, pgErrorCode } from './sql.ts';

/**
 * Credit ledger operations. See docs/04-cost-and-data.md and the extensive
 * commentary in migrations/0002_credit_ledger.sql.
 *
 * Every function here MUST be called inside a transaction (see withTransaction).
 * The row lock `reserve` takes is released at commit, so splitting a movement
 * across transactions reopens the race it exists to close.
 */

export interface Balance {
  readonly available: bigint;
  readonly reserved: bigint;
}

export class InsufficientCredits extends Error {
  constructor(
    readonly orgId: string,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(`org ${orgId}: requested ${requested} credits, only ${available} available`);
    this.name = 'InsufficientCredits';
  }
}

export class DuplicateOperation extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`operation with idempotency key ${idempotencyKey} was already applied`);
    this.name = 'DuplicateOperation';
  }
}

interface Leg {
  readonly account: 'available' | 'reserved' | 'purchased' | 'consumed';
  readonly amount: bigint;
}

interface PostOptions {
  readonly orgId: string;
  readonly entryType: 'topup' | 'reserve' | 'settle' | 'refund' | 'adjustment';
  readonly legs: readonly Leg[];
  readonly generationId?: string | undefined;
  readonly paymentId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly memo?: string | undefined;
}

/**
 * Writes one balanced set of entries and moves the materialised balance in the
 * same transaction.
 *
 * The zero-sum requirement is enforced by a deferred constraint trigger in the
 * database, so this is checked here only to fail with a useful message before
 * the round trip - never as the sole guard.
 */
async function post(tx: Queryable, opts: PostOptions): Promise<string> {
  const total = opts.legs.reduce((acc, l) => acc + l.amount, 0n);
  if (total !== 0n) {
    throw new Error(`unbalanced ${opts.entryType}: legs sum to ${total}, must be 0`);
  }

  const transactionId = randomUUID();

  for (const leg of opts.legs) {
    try {
      await tx.query(
        `INSERT INTO credit_ledger
           (transaction_id, org_id, account, entry_type, amount,
            generation_id, payment_id, idempotency_key, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          transactionId,
          opts.orgId,
          leg.account,
          opts.entryType,
          leg.amount.toString(),
          opts.generationId ?? null,
          opts.paymentId ?? null,
          // Only one leg carries the key; the unique index is partial.
          leg === opts.legs[0] ? (opts.idempotencyKey ?? null) : null,
          opts.memo ?? null,
        ],
      );
    } catch (e) {
      if (pgErrorCode(e) === UNIQUE_VIOLATION && opts.idempotencyKey) {
        throw new DuplicateOperation(opts.idempotencyKey);
      }
      throw e;
    }
  }

  const available = opts.legs
    .filter((l) => l.account === 'available')
    .reduce((a, l) => a + l.amount, 0n);
  const reserved = opts.legs
    .filter((l) => l.account === 'reserved')
    .reduce((a, l) => a + l.amount, 0n);

  // Two statements rather than an upsert with signed deltas: Postgres evaluates
  // CHECK constraints on the proposed row BEFORE resolving ON CONFLICT, so a
  // negative delta in the VALUES list fails against CHECK (available >= 0) even
  // when the resulting balance would be perfectly valid.
  await tx.query(
    `INSERT INTO credit_balances (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
    [opts.orgId],
  );
  // CHECK (available >= 0) applies to the UPDATE result, and is the backstop if
  // a caller ever bypasses the balance read above.
  await tx.query(
    `UPDATE credit_balances
        SET available  = available + $2,
            reserved   = reserved  + $3,
            updated_at = now()
      WHERE org_id = $1`,
    [opts.orgId, available.toString(), reserved.toString()],
  );

  return transactionId;
}

/**
 * Reads the balance and LOCKS the org's row for the rest of the transaction.
 *
 * This is the line that prevents the double spend: two generations starting at
 * once against a balance of 100, each reserving 80, would both read 100 and
 * both commit without it. The second caller blocks here until the first
 * commits, then reads the true remaining balance and correctly fails.
 */
export async function lockBalance(tx: Queryable, orgId: string): Promise<Balance> {
  const select = `SELECT available, reserved FROM credit_balances WHERE org_id = $1 FOR UPDATE`;

  // Select first, and only insert when the org has no row yet. An unconditional
  // `INSERT ... ON CONFLICT DO NOTHING` would write on every call for no reason,
  // and - worse - it blocks on an uncommitted conflicting row, which silently
  // serialises concurrent callers. That makes the FOR UPDATE below look
  // redundant in a two-party race while leaving it load-bearing under real
  // contention: exactly the sort of accidental correctness that disappears
  // during a later refactor.
  let { rows } = await tx.query<{ available: string; reserved: string }>(select, [orgId]);

  if (!rows[0]) {
    await tx.query(
      `INSERT INTO credit_balances (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    );
    ({ rows } = await tx.query<{ available: string; reserved: string }>(select, [orgId]));
  }

  const row = rows[0];
  if (!row) throw new Error(`no credit_balances row for org ${orgId}`);
  return { available: BigInt(row.available), reserved: BigInt(row.reserved) };
}

/** Balance without locking. Read-only callers only - never before a reserve. */
export async function getBalance(db: Queryable, orgId: string): Promise<Balance> {
  const { rows } = await db.query<{ available: string; reserved: string }>(
    `SELECT available, reserved FROM credit_balances WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  return row
    ? { available: BigInt(row.available), reserved: BigInt(row.reserved) }
    : { available: 0n, reserved: 0n };
}

/** Balance recomputed from the journal, which is authoritative. */
export async function getJournalBalance(db: Queryable, orgId: string): Promise<Balance> {
  const { rows } = await db.query<{ available: string | null; reserved: string | null }>(
    `SELECT
       COALESCE(sum(amount) FILTER (WHERE account = 'available'), 0) AS available,
       COALESCE(sum(amount) FILTER (WHERE account = 'reserved'),  0) AS reserved
     FROM credit_ledger WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  return {
    available: BigInt(row?.available ?? 0),
    reserved: BigInt(row?.reserved ?? 0),
  };
}

/** Orgs whose materialised balance disagrees with the journal. Always empty. */
export async function findBalanceDrift(db: Queryable): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query('SELECT * FROM credit_balance_drift');
  return rows;
}

export interface TopUpInput {
  readonly orgId: string;
  readonly credits: bigint;
  readonly paymentId?: string;
  /** Required. This is what makes a redelivered gateway webhook a no-op. */
  readonly idempotencyKey: string;
  readonly memo?: string;
}

/** Credits bought. Called only from a signature-verified gateway webhook. */
export async function topUp(tx: Queryable, input: TopUpInput): Promise<string> {
  if (input.credits <= 0n) throw new RangeError(`top-up must be positive, got ${input.credits}`);
  return post(tx, {
    orgId: input.orgId,
    entryType: 'topup',
    idempotencyKey: input.idempotencyKey,
    paymentId: input.paymentId,
    memo: input.memo,
    legs: [
      { account: 'available', amount: input.credits },
      { account: 'purchased', amount: -input.credits },
    ],
  });
}

export interface ReserveInput {
  readonly orgId: string;
  readonly credits: bigint;
  readonly generationId?: string;
  readonly idempotencyKey?: string;
  readonly memo?: string;
}

/** Holds credits against an in-flight generation. Fails if unaffordable. */
export async function reserve(tx: Queryable, input: ReserveInput): Promise<string> {
  if (input.credits <= 0n) throw new RangeError(`reserve must be positive, got ${input.credits}`);

  const balance = await lockBalance(tx, input.orgId);
  if (balance.available < input.credits) {
    throw new InsufficientCredits(input.orgId, input.credits, balance.available);
  }

  return post(tx, {
    orgId: input.orgId,
    entryType: 'reserve',
    generationId: input.generationId,
    idempotencyKey: input.idempotencyKey,
    memo: input.memo,
    legs: [
      { account: 'available', amount: -input.credits },
      { account: 'reserved', amount: input.credits },
    ],
  });
}

export interface SettleInput {
  readonly orgId: string;
  /** What was reserved. */
  readonly reserved: bigint;
  /** What it actually cost. May be less than, equal to, or more than reserved. */
  readonly actual: bigint;
  readonly generationId?: string;
  readonly idempotencyKey?: string;
  readonly memo?: string;
}

/**
 * Closes out a completed generation.
 *
 * The remainder returns to `available` in the same transaction, which is what
 * makes an over-estimate self-correcting rather than a slow leak. An actual
 * cost ABOVE the reservation is also handled: the excess is drawn from
 * available, which can legitimately push the org to zero but never below,
 * because CHECK (available >= 0) still applies.
 */
export async function settle(tx: Queryable, input: SettleInput): Promise<string> {
  if (input.reserved <= 0n) throw new RangeError('settle: reserved must be positive');
  if (input.actual < 0n) throw new RangeError('settle: actual must not be negative');

  await lockBalance(tx, input.orgId);
  const remainder = input.reserved - input.actual;

  const legs: Leg[] = [
    { account: 'reserved', amount: -input.reserved },
    { account: 'consumed', amount: input.actual },
  ];
  // A zero remainder means no third leg: the ledger rejects zero-amount rows.
  if (remainder !== 0n) legs.push({ account: 'available', amount: remainder });

  return post(tx, {
    orgId: input.orgId,
    entryType: 'settle',
    generationId: input.generationId,
    idempotencyKey: input.idempotencyKey,
    memo: input.memo,
    legs,
  });
}

export interface RefundInput {
  readonly orgId: string;
  readonly credits: bigint;
  readonly generationId?: string;
  readonly idempotencyKey?: string;
  readonly memo?: string;
}

/** Releases a reservation in full after a failed generation. */
export async function refund(tx: Queryable, input: RefundInput): Promise<string> {
  if (input.credits <= 0n) throw new RangeError(`refund must be positive, got ${input.credits}`);

  await lockBalance(tx, input.orgId);

  return post(tx, {
    orgId: input.orgId,
    entryType: 'refund',
    generationId: input.generationId,
    idempotencyKey: input.idempotencyKey,
    memo: input.memo,
    legs: [
      { account: 'reserved', amount: -input.credits },
      { account: 'available', amount: input.credits },
    ],
  });
}
