import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { InsufficientCredits, getBalance, getJournalBalance, reserve, topUp } from '../src/ledger.ts';
import type { Queryable } from '../src/sql.ts';

/**
 * The double-spend race, against a real Postgres.
 *
 * Two generations start at once against a balance of 100, each reserving 80.
 * Both read 100, both believe they can afford it, both commit - and the org is
 * 60 credits overdrawn. `CHECK (available >= 0)` alone does NOT catch this,
 * because each transaction validates against a snapshot the other has not
 * committed to. Only the `SELECT ... FOR UPDATE` in lockBalance() serialises
 * them.
 *
 * This cannot run on PGlite, which is single-connection and so cannot hold two
 * simultaneous transactions. It is skipped without DATABASE_URL - and the
 * README says so, because a silently skipped test looks exactly like a passing
 * one.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('concurrent reserves (needs DATABASE_URL)', () => {
  let pool: pg.Pool;
  let orgId: string;

  const wrap = (c: pg.PoolClient): Queryable => ({
    query: (text, params) => c.query(text, params ? [...params] : undefined),
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
    const c = await pool.connect();
    try {
      await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await migrate(wrap(c));
    } finally {
      c.release();
    }
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await c.query(`
        ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_no_truncate;
        TRUNCATE credit_ledger, credit_balances, generations, orgs RESTART IDENTITY CASCADE;
        ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_no_truncate;
      `);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('concurrency') RETURNING id`,
      );
      orgId = rows[0]!.id;
      await c.query('BEGIN');
      await topUp(wrap(c), { orgId, credits: 100n, idempotencyKey: `seed-${orgId}` });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  /** Opens its own connection, reserves, and reports what happened. */
  async function attemptReserve(credits: bigint): Promise<'ok' | 'insufficient'> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await reserve(wrap(c), { orgId, credits });
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e instanceof InsufficientCredits) return 'insufficient';
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Deterministic interleave, rather than firing two reserves and hoping they
   * overlap. Two racing calls from a pool often serialise by luck, so a passing
   * `Promise.all` test proves nothing about the lock.
   *
   * Here B is forced to start its reserve while A holds the lock and has not
   * committed. WITH `FOR UPDATE`, B blocks at the balance read, wakes after A
   * commits, sees 20, and raises InsufficientCredits. WITHOUT it, B reads a
   * stale 100, passes the affordability check, and only trips
   * `CHECK (available >= 0)` at the UPDATE - a different error.
   *
   * Asserting the error TYPE is what makes this a real discriminator: a check
   * violation here means the lock is gone, even though "one of them failed"
   * would look fine.
   */
  it('blocks the second reserve at the lock, not at the CHECK constraint', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await reserve(wrap(a), { orgId, credits: 80n }); // A now holds the row lock

      await b.query('BEGIN');
      const bReserve = reserve(wrap(b), { orgId, credits: 80n }); // blocks
      const outcome = bReserve.then(() => 'ok' as const).catch((e: unknown) => e);

      // Let B actually reach the blocking read before A commits.
      await new Promise((r) => setTimeout(r, 150));
      await a.query('COMMIT');

      const result = await outcome;
      expect(result).toBeInstanceOf(InsufficientCredits);
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }

    const balance = await getBalance(wrapPool(pool), orgId);
    expect(balance).toEqual({ available: 20n, reserved: 80n });
  });

  it('never overdraws under a burst of racing reserves', async () => {
    // 10 x 30 credits against a balance of 100: at most 3 can succeed.
    const results = await Promise.all(Array.from({ length: 10 }, () => attemptReserve(30n)));
    const ok = results.filter((r) => r === 'ok').length;

    expect(ok).toBe(3);
    const balance = await getBalance(wrapPool(pool), orgId);
    expect(balance.available).toBe(10n);
    expect(balance.available).toBeGreaterThanOrEqual(0n);
    expect(await getJournalBalance(wrapPool(pool), orgId)).toEqual(balance);
  });

  it('keeps the journal and the materialised balance in agreement under contention', async () => {
    await Promise.all(Array.from({ length: 8 }, () => attemptReserve(10n)));
    const { rows } = await pool.query('SELECT * FROM credit_balance_drift');
    expect(rows).toEqual([]);
  });
});

function wrapPool(p: pg.Pool): Queryable {
  return { query: (text, params) => p.query(text, params ? [...params] : undefined) };
}
