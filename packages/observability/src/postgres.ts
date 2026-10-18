type ErrorReporter = (error: Error) => void;

interface PostgresClient {
  on(event: 'error', listener: ErrorReporter): unknown;
}

interface PostgresPool {
  on(event: 'error', listener: ErrorReporter): unknown;
  on(event: 'connect', listener: (client: PostgresClient) => void): unknown;
}

// Register once in the owning factory, before connecting. A pool error listener
// covers idle clients only; the client listener must survive every checkout.
// pg retains responsibility for query rejection, invalidation, and eviction on
// release. These observers never retry a query or close an owned connection.
export function observePostgresPoolErrors(pool: PostgresPool, reportError: ErrorReporter): void {
  // pg forwards an idle client's error to the pool synchronously. Count that
  // error once; weak references retain no error objects, and one microtask
  // resets the window so a later occurrence of the same object still reports.
  let reported = new WeakSet<Error>();
  let resetQueued = false;
  const reportOnce: ErrorReporter = (error) => {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
      if (!resetQueued) {
        resetQueued = true;
        queueMicrotask(() => { reported = new WeakSet<Error>(); resetQueued = false; });
      }
    }
    reportError(error);
  };
  pool.on('error', reportOnce);
  pool.on('connect', (client) => observePostgresClientErrors(client, reportOnce));
}

export function observePostgresClientErrors(client: PostgresClient, reportError: ErrorReporter): void {
  client.on('error', reportError);
}
