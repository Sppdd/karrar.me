/**
 * Minimal query interface, satisfied by both `pg` (Pool/PoolClient) and PGlite.
 *
 * Kept this narrow deliberately: the ledger's correctness rests on constraints,
 * triggers and `SELECT ... FOR UPDATE`, and an ORM abstracts away exactly the
 * layer that has to be exact.
 */
export interface QueryResult<R> {
  readonly rows: R[];
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;

  /**
   * Runs a multi-statement script.
   *
   * Drivers speaking the extended protocol (PGlite) reject more than one
   * statement per `query`, so migration files need this path. `pg` accepts
   * multi-statement strings through `query` when there are no parameters, so
   * it can leave this undefined and the runner falls back.
   */
  exec?(sql: string): Promise<unknown>;
}

/** A Queryable that can hand out a dedicated connection for a transaction. */
export interface Transactor extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Wraps `fn` in BEGIN/COMMIT on a single connection.
 *
 * Every ledger operation MUST run inside one of these. The row lock taken in
 * `reserve` only holds until commit, so splitting a movement across two
 * transactions reopens the double-spend race the lock exists to close.
 */
export async function withTransaction<T>(
  client: Queryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback can fail if the connection died; the original error is the
      // one worth propagating.
    }
    throw e;
  }
}

/** Postgres error code, when the driver surfaces one. */
export function pgErrorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
