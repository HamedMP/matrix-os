import { Kysely, PostgresDialect, sql } from "kysely";
import type { PlatformDB, PlatformDatabase } from "../db.js";
import { createPostgresPool } from "../database/postgres-connections.js";
import { wrapPlatformDb } from "../database/transaction-scope.js";
import { assertPreviewPairDataIsolation } from "./projection.js";
import { PreviewPairAccessError } from "./readers.js";

/** Never call createPlatformDb here: its eager migrations would write before
 * target authorization. The approved candidate database is prepared separately. */
export function createPreviewPairTargetDatabase(connectionString: string): PlatformDB {
  try {
    const url = new URL(connectionString);
    if (connectionString.length > 8192 || !["postgres:", "postgresql:"].includes(url.protocol)
      || !url.hostname || !url.username || !url.pathname || url.hash) throw new PreviewPairAccessError(503);
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof PreviewPairAccessError) throw new PreviewPairAccessError(503);
    throw error;
  }
  const pool = createPostgresPool({ connectionString, max: 2, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000, application_name: "matrix-preview-pair-target" }, "preview-pair-target");
  const root = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  let closing: Promise<void> | undefined;
  const target = wrapPlatformDb(root, root, Promise.resolve(), () => closing ??= (async () => {
    // Kysely does not destroy an uninitialized driver. This factory owns the
    // pool even before its first query, so always close that owned pool too.
    try { await root.destroy(); }
    finally {
      try { await pool.end(); }
      catch (error: unknown) {
        if (!(error instanceof Error && error.message === "Called end on pool more than once")) throw error;
      }
    }
  })());
  return target;
}

/** A per-operation gate, not a constructor gate: a target outage must not stop
 * the source-owned provider/cloud retirement worker from starting. */
export async function assertPreviewPairTargetPrepared(source: PlatformDB, target: PlatformDB): Promise<void> {
  try {
    await assertPreviewPairDataIsolation(source, target);
    const result = await sql<{ prepared: boolean }>`SELECT
      to_regclass('user_machines') IS NOT NULL AND to_regclass('host_bundle_releases') IS NOT NULL AS prepared`.execute(target.executor);
    if (!result.rows[0]?.prepared) throw new PreviewPairAccessError(503);
  } catch (error: unknown) {
    console.warn("[preview-pair] target database unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new PreviewPairAccessError(503);
  }
}
