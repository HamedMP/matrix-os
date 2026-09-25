import { PostgresDialect } from "kysely";
import pg from "pg";
import { JevEvaluationRepository } from "./repository.js";

const CONNECTION_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 4_000;

type MaintenancePool = Pick<pg.Pool, "connect" | "end" | "on">;
export type JevMaintenancePoolFactory = (config: pg.PoolConfig) => MaintenancePool;

export function createOwnedJevMaintenance(options: {
  databaseUrl: string;
  now?: () => Date;
  poolFactory?: JevMaintenancePoolFactory;
}): {
  repository: JevEvaluationRepository;
  forceReleaseActive: () => void;
  close: () => Promise<void>;
} {
  const pool = (options.poolFactory ?? ((config) => new pg.Pool(config)))({
    connectionString: options.databaseUrl,
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  pool.on("error", (error: Error) => {
    console.error("[jev] Idle maintenance pool error:", error instanceof Error ? error.name : "UnknownError");
  });
  let active: { client: pg.PoolClient; released: boolean } | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const forceReleaseActive = () => {
    const lease = active;
    if (!lease || lease.released) return;
    lease.released = true;
    active = null;
    // This pool belongs only to Jev maintenance. pg-pool removes the client,
    // and pg.Client.end destroys the socket when a query is still active.
    lease.client.release(true);
  };
  const trackedPool = {
    async connect(): Promise<pg.PoolClient> {
      const client = await pool.connect();
      if (closing) {
        client.release(true);
        throw new Error("Jev maintenance is closed");
      }
      const lease = { client, released: false };
      active = lease;
      const release = (destroy = false) => {
        if (lease.released) return;
        lease.released = true;
        if (active === lease) active = null;
        client.release(destroy);
      };
      return new Proxy(client, {
        get(target, property) {
          if (property === "release") return () => release();
          if (property === "query") {
            return async (statement: string, parameters: readonly unknown[]) => {
              try {
                return await target.query(statement, [...parameters]);
              } catch (error) {
                release(true);
                throw error;
              }
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    end: () => pool.end(),
  };
  const repository = new JevEvaluationRepository(new PostgresDialect({ pool: trackedPool }), { now: options.now });

  return {
    repository,
    forceReleaseActive,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      forceReleaseActive();
      closePromise = repository.destroy();
      return closePromise;
    },
  };
}
