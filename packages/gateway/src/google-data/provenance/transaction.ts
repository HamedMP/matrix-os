import { sql, type Kysely, type Transaction } from "kysely";

/** Set before every production advisory/row lock; the injected pool remains host-owned. */
export function boundedProvenanceTransaction<DB, T>(db: Kysely<DB>, work: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  const execute = async (tx: Transaction<DB>) => {
    await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
    await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
    return work(tx);
  };
  // Trusted caller transactions retain the same locks and rollback boundary; never nest or close their pool.
  return db.isTransaction ? execute(db as Transaction<DB>) : db.transaction().execute(execute);
}

/** Optional provenance work joined to a caller transaction inside a SAVEPOINT: a lock/statement timeout or
 * failure rolls back only this section (PostgreSQL would otherwise abort the whole caller transaction), and
 * the caller's own statement/lock timeouts are restored after the bounded section. Errors still propagate. */
export async function boundedProvenanceSavepoint<DB, T>(tx: Transaction<DB>, work: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  const previous = (await sql<{ statement: string; lock: string }>`SELECT current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock`.execute(tx)).rows[0]!;
  await sql`SAVEPOINT google_provenance_section`.execute(tx);
  let result: T;
  try {
    result = await boundedProvenanceTransaction(tx, work);
  } catch (error) {
    // Rolling back to the savepoint also reverts the SET LOCAL timeouts issued inside it.
    await sql`ROLLBACK TO SAVEPOINT google_provenance_section`.execute(tx);
    await sql`RELEASE SAVEPOINT google_provenance_section`.execute(tx);
    throw error;
  }
  await sql`RELEASE SAVEPOINT google_provenance_section`.execute(tx);
  await sql`SELECT set_config('statement_timeout', ${previous.statement}, true), set_config('lock_timeout', ${previous.lock}, true)`.execute(tx);
  return result;
}
