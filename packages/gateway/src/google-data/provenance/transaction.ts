import { sql, type Kysely, type Transaction } from "kysely";

/** Set before every production advisory/row lock; the injected pool remains host-owned. */
export function boundedProvenanceTransaction<DB, T>(db: Kysely<DB>, work: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async tx => {
    await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
    await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
    return work(tx);
  });
}
