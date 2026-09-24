/** Read-only operator count of personal sync grants, separate from collaboration cutover. */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { SyncDatabase } from "./sharing-db.js";

export type PersonalSyncShareInventory =
  | { state: "missing" }
  | { state: "present"; totalGrants: number; pendingGrants: number; acceptedGrants: number; expiredGrants: number };

export async function inventoryPersonalSyncShares(db: Kysely<SyncDatabase>): Promise<PersonalSyncShareInventory> {
  // Sync starts only when its storage prerequisites exist. Its migration may
  // never have run on an otherwise valid owner database; absence is not zero.
  const table = await sql<{ name: string | null }>`SELECT to_regclass('sync_shares')::text AS name`.execute(db);
  if (!table.rows[0]?.name) return { state: "missing" };
  const counts = await sql<{
    total: string; pending: string; accepted: string; expired: string;
  }>`SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE accepted = false)::text AS pending,
      count(*) FILTER (WHERE accepted = true)::text AS accepted,
      count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now())::text AS expired
    FROM sync_shares`.execute(db);
  const row = counts.rows[0];
  if (!row) throw new Error("Personal sync inventory is unavailable");
  return {
    state: "present",
    totalGrants: safeCount(row.total),
    pendingGrants: safeCount(row.pending),
    acceptedGrants: safeCount(row.accepted),
    expiredGrants: safeCount(row.expired),
  };
}

function safeCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Personal sync inventory count is unavailable");
  return count;
}
