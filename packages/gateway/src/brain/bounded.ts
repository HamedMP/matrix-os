/**
 * Bounds for feature work on the shared owner pool: reads run in one READ ONLY transaction with a statement deadline,
 * so a slow scan cannot hold a pool connection for long, and heavy calls (brief builds, index refreshes) are capped
 * in process, answering brain_unavailable past the cap instead of queueing on the pool.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { BrainApiError } from "./api/types.js";

export const BRAIN_READ_STATEMENT_TIMEOUT_MS = 10_000;
/** Heavy calls one service runs at once. */
export const BRAIN_HEAVY_CALLS_MAX = 2;

/** `fn` inside one READ ONLY transaction whose statements each stop at BRAIN_READ_STATEMENT_TIMEOUT_MS. */
export function withBrainRead<DB, T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout = ${sql.lit(`${BRAIN_READ_STATEMENT_TIMEOUT_MS}ms`)}`.execute(trx);
    return fn(trx);
  });
}

/** Runs at most `max` calls at once; one more is refused with brain_unavailable (logged by `name`). */
export function brainCallCap(
  name: string, max: number = BRAIN_HEAVY_CALLS_MAX,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  return async (fn) => {
    if (running >= max) {
      console.warn(`[brain] ${name} refused: ${running} already running`);
      throw new BrainApiError("brain_unavailable");
    }
    running += 1;
    try {
      return await fn();
    } finally {
      running -= 1;
    }
  };
}
