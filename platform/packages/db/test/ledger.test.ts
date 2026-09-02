import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateOperation,
  InsufficientCredits,
  findBalanceDrift,
  getBalance,
  getJournalBalance,
  refund,
  reserve,
  settle,
  topUp,
} from '../src/ledger.ts';
import { type TestDb, inTx, makeDb, seedGeneration } from './helpers.ts';

let db: TestDb;
beforeAll(async () => { db = await makeDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.reset(); });

const key = (() => { let n = 0; return () => `key-${++n}`; })();

describe('the four movements', () => {
  it('top-up moves credits from purchased into available', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: key() }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 1000n, reserved: 0n });
    expect(await getJournalBalance(db, db.orgId)).toEqual({ available: 1000n, reserved: 0n });
  });

  it('reserve holds credits without destroying them', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 50n }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 950n, reserved: 50n });
  });

  it('settle returns the unspent remainder in the same transaction', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 50n }));
    await inTx(db, (tx) => settle(tx, { orgId: db.orgId, reserved: 50n, actual: 45n }));

    // 1000 - 45 spent = 955 available, nothing left reserved.
    expect(await getBalance(db, db.orgId)).toEqual({ available: 955n, reserved: 0n });
  });

  it('settle with no remainder writes only two legs', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 100n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 40n }));
    // A zero-amount third leg would violate CHECK (amount <> 0).
    await inTx(db, (tx) => settle(tx, { orgId: db.orgId, reserved: 40n, actual: 40n }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 60n, reserved: 0n });
  });

  it('settle handles an actual cost above the reservation', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 100n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 40n }));
    // Provider billed 55 against a 40 reservation: the excess comes out of available.
    await inTx(db, (tx) => settle(tx, { orgId: db.orgId, reserved: 40n, actual: 55n }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 45n, reserved: 0n });
  });

  it('refund releases a reservation in full after a failed generation', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 50n }));
    await inTx(db, (tx) => refund(tx, { orgId: db.orgId, credits: 50n }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 1000n, reserved: 0n });
  });
});

describe('invariant: append-only', () => {
  beforeEach(async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 100n, idempotencyKey: key() }));
  });

  it('rejects UPDATE on the journal', async () => {
    await expect(db.query('UPDATE credit_ledger SET amount = 999')).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE on the journal', async () => {
    await expect(db.query('DELETE FROM credit_ledger')).rejects.toThrow(/append-only/);
  });

  it('rejects TRUNCATE, which row-level triggers do not cover', async () => {
    await expect(db.query('TRUNCATE credit_ledger')).rejects.toThrow(/append-only/);
  });

  it('leaves the balance untouched after a rejected mutation', async () => {
    await db.query('UPDATE credit_ledger SET amount = 999').catch(() => {});
    expect(await getJournalBalance(db, db.orgId)).toEqual({ available: 100n, reserved: 0n });
  });
});

describe('invariant: transactions balance to zero', () => {
  it('rejects an unbalanced transaction at COMMIT, not before', async () => {
    // The deferred constraint trigger must allow the first leg to land - entries
    // are inserted one at a time and only balance once the set is complete.
    await expect(
      inTx(db, async (tx) => {
        await tx.query(
          `INSERT INTO credit_ledger (transaction_id, org_id, account, entry_type, amount)
           VALUES (gen_random_uuid(), $1, 'available', 'adjustment', 500)`,
          [db.orgId],
        );
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('accepts a balanced hand-written transaction', async () => {
    await inTx(db, async (tx) => {
      await tx.query(
        `INSERT INTO credit_ledger (transaction_id, org_id, account, entry_type, amount)
         VALUES ($2, $1, 'available', 'adjustment', 500),
                ($2, $1, 'purchased', 'adjustment', -500)`,
        [db.orgId, '11111111-1111-1111-1111-111111111111'],
      );
    });
    expect(await getJournalBalance(db, db.orgId)).toEqual({ available: 500n, reserved: 0n });
  });

  it('rejects a zero-amount entry as noise', async () => {
    await expect(
      db.query(
        `INSERT INTO credit_ledger (transaction_id, org_id, account, entry_type, amount)
         VALUES (gen_random_uuid(), $1, 'available', 'adjustment', 0)`,
        [db.orgId],
      ),
    ).rejects.toThrow();
  });

  it('refuses to post an unbalanced movement from application code', async () => {
    // Guarded in post() as well, so the failure is legible before the round trip.
    await expect(
      inTx(db, (tx) => settle(tx, { orgId: db.orgId, reserved: -5n, actual: 1n })),
    ).rejects.toThrow(RangeError);
  });
});

describe('invariant: the balance never goes negative', () => {
  it('refuses a reserve larger than the balance', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 30n, idempotencyKey: key() }));
    await expect(
      inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 80n })),
    ).rejects.toThrow(InsufficientCredits);
    expect(await getBalance(db, db.orgId)).toEqual({ available: 30n, reserved: 0n });
  });

  it('refuses a reserve against no balance at all', async () => {
    await expect(
      inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 1n })),
    ).rejects.toThrow(InsufficientCredits);
  });

  it('CHECK (available >= 0) still backstops a caller that bypasses the read', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 10n, idempotencyKey: key() }));
    await expect(
      db.query('UPDATE credit_balances SET available = -1 WHERE org_id = $1', [db.orgId]),
    ).rejects.toThrow();
  });

  it('allows spending down to exactly zero', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 40n, idempotencyKey: key() }));
    await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: 40n }));
    await inTx(db, (tx) => settle(tx, { orgId: db.orgId, reserved: 40n, actual: 40n }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 0n, reserved: 0n });
  });
});

describe('invariant: idempotency', () => {
  it('rejects a redelivered top-up carrying the same key', async () => {
    const k = key();
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: k }));
    await expect(
      inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 1000n, idempotencyKey: k })),
    ).rejects.toThrow(DuplicateOperation);
    // Credited once, not twice.
    expect(await getBalance(db, db.orgId)).toEqual({ available: 1000n, reserved: 0n });
  });

  it('allows distinct keys through', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 500n, idempotencyKey: key() }));
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 500n, idempotencyKey: key() }));
    expect(await getBalance(db, db.orgId)).toEqual({ available: 1000n, reserved: 0n });
  });

  it('scopes keys per org, so two orgs may reuse one gateway reference', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('other') RETURNING id`,
    );
    const other = rows[0]!.id;
    const shared = 'wayl-ref-shared';
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 10n, idempotencyKey: shared }));
    await inTx(db, (tx) => topUp(tx, { orgId: other, credits: 10n, idempotencyKey: shared }));
    expect((await getBalance(db, other)).available).toBe(10n);
  });
});

describe('rejects nonsense inputs', () => {
  it.each([
    ['top-up', () => inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 0n, idempotencyKey: key() }))],
    ['reserve', () => inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: -5n }))],
    ['refund', () => inTx(db, (tx) => refund(tx, { orgId: db.orgId, credits: 0n }))],
  ])('%s must be a positive amount', async (_label, run) => {
    await expect(run()).rejects.toThrow(RangeError);
  });
});

describe('journal and materialised balance agree', () => {
  it('after a randomised sequence of operations', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 10_000n, idempotencyKey: key() }));

    let held = 0n;
    for (let i = 0; i < 40; i++) {
      const amount = BigInt(1 + ((i * 7) % 23));
      const gid = await seedGeneration(db, db.orgId, `gen-${i}`);
      await inTx(db, (tx) => reserve(tx, { orgId: db.orgId, credits: amount, generationId: gid }));
      held = amount;

      if (i % 3 === 0) {
        await inTx(db, (tx) => refund(tx, { orgId: db.orgId, credits: held, generationId: gid }));
      } else {
        const actual = i % 2 === 0 ? held : held - 1n > 0n ? held - 1n : held;
        await inTx(db, (tx) =>
          settle(tx, { orgId: db.orgId, reserved: held, actual, generationId: gid }),
        );
      }
    }

    const materialised = await getBalance(db, db.orgId);
    const journal = await getJournalBalance(db, db.orgId);
    expect(materialised).toEqual(journal);
    expect(materialised.reserved).toBe(0n);
    expect(await findBalanceDrift(db)).toEqual([]);
  });

  it('a rolled-back transaction leaves neither side changed', async () => {
    await inTx(db, (tx) => topUp(tx, { orgId: db.orgId, credits: 100n, idempotencyKey: key() }));
    await inTx(db, async (tx) => {
      await reserve(tx, { orgId: db.orgId, credits: 50n });
      throw new Error('boom');
    }).catch(() => {});

    expect(await getBalance(db, db.orgId)).toEqual({ available: 100n, reserved: 0n });
    expect(await getJournalBalance(db, db.orgId)).toEqual({ available: 100n, reserved: 0n });
    expect(await findBalanceDrift(db)).toEqual([]);
  });
});
