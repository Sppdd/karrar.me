import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './sql.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

/**
 * Applies pending migrations in filename order.
 *
 * Idempotent: a second run applies nothing. Each migration runs inside its own
 * transaction alongside the bookkeeping insert, so a failure part-way through a
 * file leaves neither the schema change nor the record of it.
 */
export async function migrate(db: Queryable, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`no .sql migrations found in ${dir}`);

  // Migration files hold many statements; use the driver's script path when it
  // has one (see Queryable.exec).
  const runScript = (sql: string): Promise<unknown> =>
    db.exec ? db.exec(sql) : db.query(sql);

  // The bootstrap migration creates the bookkeeping table, so it runs first and
  // outside the "already applied?" check.
  const [bootstrap, ...rest] = files;
  await runScript(await readFile(join(dir, bootstrap as string), 'utf8'));

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of rest) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    await db.query('BEGIN');
    try {
      await runScript(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }

  return { applied, skipped };
}
