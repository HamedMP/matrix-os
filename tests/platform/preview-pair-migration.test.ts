import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";

describe("pair lifecycle schema is part of real Platform startup", () => {
  let db: PlatformDB;
  beforeAll(async () => { ({ db } = await createTestPlatformDb({ freshSchema: true })); });
  afterAll(async () => { await destroyTestPlatformDb(db); });

  it("creates all durable pair tables including pre-admission cloud recovery", async () => {
    const result = await sql<{ tablename: string }>`SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename LIKE 'preview_pair%'
      ORDER BY tablename`.execute(db.executor);
    expect(result.rows.map(row => row.tablename)).toEqual([
      "preview_pair_cloud_intents", "preview_pair_fixtures", "preview_pair_generations", "preview_pair_members", "preview_pairs",
    ]);
  });

  it("tracks the new schema independently of the core migration generation", async () => {
    const result = await sql<{ generation: number; fingerprint: string }>`SELECT generation, fingerprint
      FROM platform_schema_revisions WHERE scope = 'preview-pairs'`.execute(db.executor);
    expect(result.rows).toEqual([{ generation: 4, fingerprint: "collaboration-preview-pair-publication-v4" }]);
  });
});
