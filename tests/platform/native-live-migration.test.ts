import { Kysely, sql } from "kysely";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it } from "vitest";
import { createPlatformDb } from "../../packages/platform/src/db.js";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { migratePlatformSchema } from "../../packages/platform/src/database/migrate.js";
import { NATIVE_LIVE_SCHEMA_REVISION } from "../../packages/platform/src/native-live/migration-revision.js";

it("installs native Live against a newer core database without changing its revision", async () => {
  const instance = await KyselyPGlite.create();
  const seed = new Kysely<Record<string, never>>({ dialect: instance.dialect });
  await runPlatformMigration(seed, migratePlatformSchema, { revision: { generation: 999, fingerprint: "newer-core" } });
  await sql`DROP TABLE IF EXISTS native_live_sessions`.execute(seed);
  const db = createPlatformDb({ dialect: instance.dialect });
  try {
    await db.ready;
    const table = await sql<{ name: string | null }>`SELECT to_regclass('native_live_sessions')::text AS name`.execute(db.executor);
    expect(table.rows[0]?.name).toBe("native_live_sessions");
    const revisions = await sql<{ scope: string; generation: number; fingerprint: string }>`SELECT scope, generation, fingerprint FROM platform_schema_revisions`.execute(db.executor);
    expect(revisions.rows).toContainEqual(expect.objectContaining({ scope: "core", generation: 999, fingerprint: "newer-core" }));
    expect(revisions.rows).toContainEqual(expect.objectContaining({ scope: "native-live", generation: 1 }));
  } finally { await db.destroy(); }
});

it("requires the guarded revision fingerprint to track ledger DDL changes", async () => {
  const source = await readFile("packages/platform/src/native-live/migration.ts");
  expect(NATIVE_LIVE_SCHEMA_REVISION.fingerprint).toBe(createHash("sha256").update(source).digest("hex"));
});
