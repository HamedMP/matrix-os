import type { Dialect, Driver } from "kysely";

const MAX_PENDING_CONNECTIONS = 128;

/** PGlite has one PostgreSQL session, so a transaction must own its whole lease. */
export function singleSessionTestDialect(dialect: Dialect): Dialect {
  return {
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: db => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createDriver: () => singleSessionDriver(dialect.createDriver()),
  };
}

function singleSessionDriver(driver: Driver): Driver {
  let busy = false;
  let closed = false;
  let idle = Promise.resolve();
  let finishIdle = () => {};
  // FIFO, capped below; release drains it and shutdown rejects every waiter.
  const waiting: Array<{ resolve(): void; reject(error: Error): void }> = [];
  function releaseLease() {
    const next = waiting.shift();
    if (next) next.resolve();
    else { busy = false; finishIdle(); }
  }
  return {
    init: () => driver.init(),
    async acquireConnection() {
      if (closed) throw new Error("Test database is closed");
      if (busy) {
        if (waiting.length >= MAX_PENDING_CONNECTIONS) throw new Error("Test database connection queue is full");
        await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
      } else {
        busy = true;
        idle = new Promise<void>(resolve => { finishIdle = resolve; });
      }
      let acquired = false;
      try {
        if (closed) throw new Error("Test database is closed");
        const connection = await driver.acquireConnection();
        acquired = true;
        return connection;
      } finally { if (!acquired) releaseLease(); }
    },
    beginTransaction: (connection, settings) => driver.beginTransaction(connection, settings),
    commitTransaction: connection => driver.commitTransaction(connection),
    rollbackTransaction: connection => driver.rollbackTransaction(connection),
    async releaseConnection(connection) {
      try { await driver.releaseConnection(connection); }
      finally { releaseLease(); }
    },
    async destroy() {
      closed = true;
      for (const waiter of waiting.splice(0)) waiter.reject(new Error("Test database is closed"));
      await idle;
      await driver.destroy();
    },
  };
}
