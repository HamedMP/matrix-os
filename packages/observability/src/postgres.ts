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
  pool.on('error', reportError);
  pool.on('connect', (client) => observePostgresClientErrors(client, reportError));
}

export function observePostgresClientErrors(client: PostgresClient, reportError: ErrorReporter): void {
  client.on('error', reportError);
}
