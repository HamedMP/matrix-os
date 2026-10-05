import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { migrateFundedProbeBudget } from "../../packages/platform/src/funded-probe-budget-migration.js";
import { FUNDED_PROBE_BUDGET_SCHEMA_REVISION } from "../../packages/platform/src/funded-probe-budget-migration-revision.js";

it("installs independently of a newer core and preserves the exhausted global allowance", async () => {
  const pg = await KyselyPGlite.create(); const db = new Kysely<Record<string, never>>({ dialect: pg.dialect });
  try {
    await runPlatformMigration(db, async trx => {
      await sql`CREATE TABLE ai_funded_model_probe_budget (budget_key TEXT PRIMARY KEY CHECK (budget_key = 'global'), day_used INTEGER NOT NULL)`.execute(trx);
      await sql`INSERT INTO ai_funded_model_probe_budget VALUES ('global', 20)`.execute(trx);
    }, { revision: { generation: 12, fingerprint: "newer-core" } });
    await runPlatformMigration(db, async () => { throw new Error("must not downgrade core"); },
      { revision: { generation: 5, fingerprint: "older-core" } });
    await runPlatformMigration(db, migrateFundedProbeBudget, { scope: "funded-probe-budget", revision: FUNDED_PROBE_BUDGET_SCHEMA_REVISION });
    await sql`INSERT INTO ai_funded_model_probe_budget VALUES ('preview-test', 1)`.execute(db);
    expect((await sql<{ budget_key: string; day_used: number }>`SELECT budget_key, day_used FROM ai_funded_model_probe_budget ORDER BY budget_key`.execute(db)).rows)
      .toEqual([{ budget_key: "global", day_used: 20 }, { budget_key: "preview-test", day_used: 1 }]);
    expect((await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope = 'core'`.execute(db)).rows[0]?.generation).toBe(12);
    await runPlatformMigration(db, async () => { throw new Error("must not repeat feature DDL"); },
      { scope: "funded-probe-budget", revision: FUNDED_PROBE_BUDGET_SCHEMA_REVISION });
    await expect(sql`INSERT INTO ai_funded_model_probe_budget VALUES ('user-selected', 0)`.execute(db)).rejects.toThrow();
  } finally { await db.destroy(); }
});
it("pins the additive migration fingerprint", async () => {
  const source = await readFile("packages/platform/src/funded-probe-budget-migration.ts");
  expect(FUNDED_PROBE_BUDGET_SCHEMA_REVISION.fingerprint).toBe(createHash("sha256").update(source).digest("hex"));
});
