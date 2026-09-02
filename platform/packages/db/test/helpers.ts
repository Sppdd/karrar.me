import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.ts';
import type { Queryable } from '../src/sql.ts';

/**
 * A real Postgres, in-process (PGlite compiles Postgres to WASM). Not a mock:
 * the triggers, constraint triggers and CHECK constraints under test are the
 * exact ones that will run in production.
 *
 * One instance per test file, reset between tests. Booting PGlite costs ~2.5s,
 * so a fresh instance per test put the suite at 70s - slow enough that people
 * stop running it, which is a worse outcome than the tiny coupling of a shared
 * instance.
 *
 * Limitation: PGlite is single-connection and cannot hold two simultaneous
 * transactions, so the concurrent double-spend case is covered separately in
 * concurrency.test.ts, which needs a real server.
 */
export interface TestDb extends Queryable {
  orgId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TABLES = [
  'credit_ledger',
  'credit_balances',
  'payment_webhook_events',
  'payments',
  'generations',
  'assets',
  'shots',
  'projects',
  'brands',
  'memberships',
  'users',
  'orgs',
];

export async function makeDb(): Promise<TestDb> {
  const pg = new PGlite();
  const query: Queryable['query'] = async (text, params) =>
    (await pg.query(text, params ? [...params] : undefined)) as { rows: never[] };
  const exec = (sql: string) => pg.exec(sql);

  await migrate({ query, exec });

  const db: TestDb = {
    query,
    exec,
    orgId: '',
    async reset() {
      // The append-only triggers deliberately block TRUNCATE on credit_ledger
      // (see 0002_credit_ledger.sql). Tests own the table, so they may lift the
      // guard for the reset and put it straight back.
      await pg.exec(`
        ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_no_truncate;
        TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE;
        ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_no_truncate;
      `);
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO orgs (name) VALUES ('test org') RETURNING id`,
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('failed to seed org');
      db.orgId = id;
    },
    close: () => pg.close(),
  };

  await db.reset();
  return db;
}

/** Runs `fn` in a transaction, mirroring how the API must call the ledger. */
export async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

export async function seedGeneration(db: Queryable, orgId: string, key: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO generations
       (org_id, provider_id, model, tier, attempt, idempotency_key, duration_s, estimated_micros)
     VALUES ($1, 'kling', 'kling-3.0', 'draft', 1, $2, 4, 400000)
     RETURNING id`,
    [orgId, key],
  );
  return rows[0]!.id;
}
