import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely, Transaction } from 'kysely';
import type { PlatformDB, PlatformDatabase } from '../db.js';

type Executor = Kysely<PlatformDatabase> | Transaction<PlatformDatabase>;
// Request-local dependency scope. No process-global DB replacement, registry or pool ownership.
const scope = new AsyncLocalStorage<{ root: Kysely<PlatformDatabase>; executor: Executor; active: boolean }>();

/** Compose the DB wrapper once; resolve the active connection at operation time. */
export function wrapPlatformDb(
  root: Kysely<PlatformDatabase>, executor: Executor, ready: Promise<void>,
  destroyFn: () => Promise<void>, transactionScoped = false,
): PlatformDB {
  function activeExecutor(): Executor {
    const current = scope.getStore();
    return current?.root === root && current.active ? current.executor : executor;
  }
  const wrapped: PlatformDB = {
    get kysely() { return activeExecutor(); },
    get executor() { return activeExecutor(); },
    ready,
    async transaction(work) {
      await ready;
      const active = activeExecutor();
      // Transactions nested in an admitted request reuse its connection and rollback boundary.
      if (active !== root || transactionScoped) {
        return work(wrapPlatformDb(root, active, Promise.resolve(), destroyFn, true));
      }
      return root.transaction().execute(trx => {
        const current = { root, executor: trx, active: true };
        return scope.run(current, async () => {
          try { return await work(wrapPlatformDb(root, trx, Promise.resolve(), destroyFn, true)); }
          finally { current.active = false; }
        });
      });
    },
    destroy: transactionScoped ? async () => undefined : destroyFn,
  };
  return wrapped;
}
