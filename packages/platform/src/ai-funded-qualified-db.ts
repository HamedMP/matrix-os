import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { PlatformDB, PlatformDatabase } from './db.js';
import { wrapPlatformDb } from './database/transaction-scope.js';
import { assertQualifiedLive, QualifiedFundedError } from './ai-funded-qualified-errors.js';

/** Dedicated opt-in owner. No migrations and no access to/shared closure of the host pool.
 * Cap admission at pool capacity, eliminating queued pool work; handshake itself has a 1s timeout. */
export function createQualifiedFundedTransactionRunner(options: { connectionString: string; maxConnections?: number }) {
  const max = options.maxConnections ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 4 || !options.connectionString) throw new QualifiedFundedError();
  const pool = new pg.Pool({ connectionString: options.connectionString, max, connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 30000, statement_timeout: 5000, lock_timeout: 2000 });
  pool.on('error', error => console.warn('[qualified-db] Connection:', error.name));
  const active = new Set<AbortController>(); // <=max; removed only after real client/transaction drains.
  let closed = false; let drained = Promise.resolve(); let finishDrain: (() => void) | undefined; let closing: Promise<void> | undefined;
  return {
    async run<T>(parent: AbortSignal, deadlineAt: number, work: (transaction: PlatformDB) => Promise<T>): Promise<T> {
      if (closed || active.size >= max) throw new QualifiedFundedError(); assertQualifiedLive(parent, deadlineAt);
      const controller = new AbortController(); if (!active.size) drained = new Promise(resolve => { finishDrain = resolve; }); active.add(controller);
      const signal = AbortSignal.any([parent, controller.signal]); const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now())); timer.unref?.();
      let client: pg.PoolClient | undefined; let ending: Promise<void> | undefined; let database: Kysely<PlatformDatabase> | undefined;
      const connectionError = (error: Error) => { console.warn('[qualified-db] Borrowed connection:', error.name); controller.abort(); };
      const abort = () => { if (client instanceof pg.Client && !ending) ending = client.end().catch((error: unknown) => console.warn('[qualified-db] End:', error instanceof Error ? error.name : 'UnknownError')); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        client = await pool.connect(); client.on('error', connectionError);
        if (!(client instanceof pg.Client)) throw new QualifiedFundedError();
        if (signal.aborted) abort(); assertQualifiedLive(signal, deadlineAt);
        const actual = client;
        // Installed Kysely uses only query/release. Facade release/end cannot return/close the actual borrowed resource.
        const facade = new Proxy(actual, { get(target, key) { if (key === 'release') return () => undefined;
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
        database = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: { connect: async () => facade, end: async () => undefined } }) });
        return await database.transaction().execute(async transaction => {
          assertQualifiedLive(signal, deadlineAt);
          const remaining = Math.max(1, Math.min(5000, deadlineAt - Date.now()));
          await sql`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true), set_config('lock_timeout', ${`${Math.min(2000, remaining)}ms`}, true)`.execute(transaction);
          const wrapped = wrapPlatformDb(database!, transaction, Promise.resolve(), async () => undefined, true);
          const result = await work(wrapped); assertQualifiedLive(signal, deadlineAt); return result;
        });
      } catch (error) { if (error instanceof QualifiedFundedError) throw error; throw new QualifiedFundedError(); }
      finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        await database?.destroy(); await ending; client?.release(!!ending); client?.removeListener('error', connectionError);
        active.delete(controller); if (!active.size) { finishDrain?.(); finishDrain = undefined; }
      }
    },
    close() { if (!closing) { closed = true; for (const operation of active) operation.abort(); closing = drained.then(() => pool.end()); } return closing; },
  };
}
export type QualifiedFundedTransactionRunner = ReturnType<typeof createQualifiedFundedTransactionRunner>;
