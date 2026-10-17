import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { BrowserApprovalRepository } from "./browser-approval-repository.js";
import type { ChatDatabase } from "./database.js";

type OwnedPool = Pick<pg.Pool, "connect" | "end" | "on">;
/** This is a separate bounded pool to the SAME owner Postgres. It never changes
 * or destroys the shared Chat pool; B must wire close into gateway shutdown.
 */
export function createOwnedBrowserApprovalAuthority(options: {
  databaseUrl: string;
  verifyDecision: ConstructorParameters<typeof BrowserApprovalRepository>[1]["verifyDecision"];
  verifyRevoke: ConstructorParameters<typeof BrowserApprovalRepository>[1]["verifyRevoke"];
  poolFactory?: (config: pg.PoolConfig) => OwnedPool;
  shutdownTimeoutMs?: number;
}) {
  const pool = (options.poolFactory ?? (config => new pg.Pool(config)))({ connectionString: options.databaseUrl,
    max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
  pool.on("error", (error: Error) => console.warn("[browser-approval] Idle owned connection unavailable", error.name));
  const leases = new Set<{ client: pg.PoolClient; released: boolean }>(); // max2; release/force eviction
  let closing = false;
  let ended: Promise<void> | undefined;
  const end = () => ended ??= pool.end();
  const release = (lease: { client: pg.PoolClient; released: boolean }, destroy = false) => {
    if (lease.released) return;
    lease.released = true; leases.delete(lease); lease.client.release(destroy);
  };
  const force = () => { for (const lease of [...leases]) release(lease, true); };
  const tracked = {
    async connect(): Promise<pg.PoolClient> {
      const client = await pool.connect();
      if (closing || leases.size >= 2) { client.release(true); throw new Error("Browser approval unavailable"); }
      const lease = { client, released: false }; leases.add(lease);
      return new Proxy(client, { get(target, property) {
        if (property === "release") return () => release(lease);
        if (property === "query") return async (statement: string, parameters: readonly unknown[]) => {
          try { return await target.query(statement, [...parameters]); }
          catch (error: unknown) { release(lease, true); throw error; }
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    end,
  };
  const db = new Kysely<ChatDatabase>({ dialect: new PostgresDialect({ pool: tracked }) });
  const repository = new BrowserApprovalRepository(db, { boundedConnectionAcquisition: true,
    verifyDecision: options.verifyDecision, verifyRevoke: options.verifyRevoke });
  let closePromise: Promise<void> | undefined;
  return { repository, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const timer = setTimeout(force, Math.max(1, Math.min(options.shutdownTimeoutMs ?? 8000, 8000))); timer.unref?.();
      try { await repository.close(); } finally { clearTimeout(timer); force(); try { await db.destroy(); } finally { await end(); } }
    })();
    return closePromise;
  } };
}
