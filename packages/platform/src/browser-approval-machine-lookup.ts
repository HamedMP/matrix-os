import pg from "pg";
import { z } from "zod/v4";
const Handle = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Slot = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
/** Private bounded Platform pool; never borrows the unbounded global lookup pool. */
export class BrowserApprovalMachineLookup {
  private readonly pool: Pick<pg.Pool, "connect" | "end" | "on">;
  private readonly clients = new Set<{ client: pg.PoolClient; released: boolean }>(); // <=2; finally/close eviction
  private readonly operations = new Set<Promise<unknown>>(); // <=8; finally/close drain
  private closing = false;
  private closed: Promise<void> | undefined;
  constructor(options: { databaseUrl: string; poolFactory?: (config: pg.PoolConfig) => Pick<pg.Pool, "connect" | "end" | "on"> }) {
    this.pool = (options.poolFactory ?? (config => new pg.Pool(config)))({ connectionString: options.databaseUrl,
      max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000, options: "-c lock_timeout=3000" });
    this.pool.on("error", (error: Error) => console.warn("[browser-approval] Owned lookup unavailable", error.name));
  }
  private release(lease: { client: pg.PoolClient; released: boolean }, destroy = false) {
    if (lease.released) return;
    lease.released = true; this.clients.delete(lease); lease.client.release(destroy);
  }
  resolveMachine(handle: string, runtimeSlot: string) {
    Handle.parse(handle); Slot.parse(runtimeSlot);
    if (this.closing || this.operations.size >= 8) return Promise.reject(new Error("Browser approval unavailable"));
    const result = (async () => {
      const client = await this.pool.connect();
      if (this.closing || this.clients.size >= 2) { client.release(true); throw new Error("Browser approval unavailable"); }
      const lease = { client, released: false }; this.clients.add(lease);
      try {
        const result = await client.query<{ clerk_user_id: string; runtime_slot: string; status: string }>(
          "SELECT clerk_user_id,runtime_slot,status FROM user_machines WHERE handle=$1 AND runtime_slot=$2 AND status='running' AND activation_state='authorized' AND deleted_at IS NULL LIMIT 1", [handle, runtimeSlot]);
        const row = result.rows[0];
        return row ? { clerkUserId: row.clerk_user_id, runtimeSlot: row.runtime_slot, status: row.status } : undefined;
      } catch (error: unknown) { this.release(lease, true); throw error; }
      finally { this.release(lease); }
    })().finally(() => { this.operations.delete(result); });
    this.operations.add(result); return result;
  }
  close() {
    if (this.closed) return this.closed;
    this.closing = true;
    for (const lease of [...this.clients]) this.release(lease, true);
    this.closed = (async () => { await Promise.allSettled([...this.operations]); await this.pool.end(); })();
    return this.closed;
  }
}
