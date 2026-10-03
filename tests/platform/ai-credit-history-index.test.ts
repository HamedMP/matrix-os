import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

describe("credit history indexed pagination", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: "history-index-machine", clerkUserId: "history-owner", runtimeSlot: "primary", handle: "history-index-machine", status: "running", imageVersion: "v1", activationState: "authorized", provisionedAt: "2026-10-01T00:00:00.000Z" });
    await sql`INSERT INTO ai_funded_credit_ledger (entry_id, owner_id, machine_id, runtime_slot, kind, amount_microusd, source_reference, created_at)
      SELECT 'history-entry-' || n, 'history-owner', 'history-index-machine', 'primary', 'addon_grant', 1, 'fixture',
        '2026-10-01T00:00:00.000Z' FROM generate_series(1, 10000) AS n`.execute(db.executor);
    await sql`ANALYZE ai_funded_credit_ledger`.execute(db.executor);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("uses the scoped expression index for the opaque anchor instead of hashing the owner ledger", async () => {
    const marker = (await sql<{ cursor: string }>`SELECT md5('history-entry-9000:history-owner:history-index-machine:primary') AS cursor`.execute(db.executor)).rows[0]!.cursor;
    const plan = await sql<{ "QUERY PLAN": string }>`EXPLAIN SELECT entry_id, created_at FROM ai_funded_credit_ledger AS l
      WHERE owner_id = 'history-owner' AND machine_id = 'history-index-machine' AND runtime_slot = 'primary'
        AND md5(l.entry_id || ':' || l.owner_id || ':' || l.machine_id || ':' || l.runtime_slot) = ${marker}`.execute(db.executor);
    const text = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("idx_ai_funded_ledger_history_cursor");
    expect(text).toMatch(/Index Cond:.*md5/);
    expect(text).not.toContain("Seq Scan");
  });

  it("uses the scoped stable-order index for a bounded history page without sorting the ledger", async () => {
    const plan = await sql<{ "QUERY PLAN": string }>`EXPLAIN SELECT entry_id, created_at FROM ai_funded_credit_ledger
      WHERE owner_id = 'history-owner' AND machine_id = 'history-index-machine' AND runtime_slot = 'primary'
      ORDER BY created_at DESC, entry_id DESC LIMIT 21`.execute(db.executor);
    const text = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("idx_ai_funded_ledger_history_page");
    expect(text).not.toContain("Sort");
  });

  it("upgrades the previous core generation idempotently while retaining ledger values", async () => {
    await sql`DROP INDEX idx_ai_funded_ledger_history_cursor`.execute(db.executor);
    await sql`DROP INDEX idx_ai_funded_ledger_history_page`.execute(db.executor);
    await sql`UPDATE platform_schema_revisions SET generation = 11, fingerprint = 'previous-core' WHERE scope = 'core'`.execute(db.executor);
    await runPlatformStartupMigrations(db.executor);
    await runPlatformStartupMigrations(db.executor);
    const indexes = await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'ai_funded_credit_ledger' AND indexname IN ('idx_ai_funded_ledger_history_cursor', 'idx_ai_funded_ledger_history_page')`.execute(db.executor);
    expect(indexes.rows).toHaveLength(2);
    const retained = await sql<{ count: number; total: string }>`SELECT count(*)::int AS count, sum(amount_microusd)::text AS total FROM ai_funded_credit_ledger`.execute(db.executor);
    expect(retained.rows[0]).toEqual({ count: 10000, total: "10000" });
  });
});
