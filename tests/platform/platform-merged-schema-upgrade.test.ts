import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDatabase } from "../../packages/platform/src/db.js";
import { migratePlatformSchema } from "../../packages/platform/src/database/migrate.js";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { migrateGenerationSeven } from "./fixtures/platform-generation-seven.js";

// Deployed predecessor from aff9984698: its generation must not be reused for
// the different schema assembled by the main/Pi integration merge.
const previous = {
  generation: 7,
  fingerprint: "c995527e209702dcaac1e0a5bce3cedcc3cd708ec877aa8a44abea93dfb406f0",
};

describe("merged platform schema upgrade", () => {
  it("upgrades generation 7 additively, preserves owner data, and keeps rollout guards", async () => {
    const instance = await KyselyPGlite.create();
    const db = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
    try {
      await runPlatformMigration(db, async (trx) => {
        await migrateGenerationSeven(trx);
        await sql`
          INSERT INTO preview_drive_grants
            (token_hash, kind, proof_nonce_hash, handle, actor_id, chat_id, turn_id, run_id,
              client_request_id, body_digest, expires_at)
          VALUES ('legacy-grant', 'run', 'proof', 'owner', 'owner', 'chat', 'turn', 'run',
            'request', 'digest', '2026-11-01')
        `.execute(trx);
        await sql`
          INSERT INTO user_machines (machine_id, clerk_user_id, handle, provisioned_at)
          VALUES ('machine', 'owner', 'owner', '2026-10-01T00:00:00.000Z')
        `.execute(trx);
        await sql`
          INSERT INTO ai_funded_runtime_policies
            (machine_id, owner_id, runtime_slot, enabled, allowed_model_ids, created_at, updated_at)
          VALUES ('machine', 'owner', 'primary', TRUE, '["managed-model"]', '2026-10-01', '2026-10-01')
        `.execute(trx);
        await sql`
          INSERT INTO ai_funded_runtime_balances
            (machine_id, owner_id, runtime_slot, credit_balance_microusd, month_period_start, updated_at)
          VALUES ('machine', 'owner', 'primary', 123456, '2026-10-01', '2026-10-01')
        `.execute(trx);
        await sql`
          INSERT INTO ai_runtime_credentials
            (token_id, token_hash, owner_id, machine_id, runtime_slot, audience, scope, issued_at, expires_at)
          VALUES ('credential', ${"a".repeat(64)}, 'owner', 'machine', 'primary',
            'matrix-funded-relay', 'ai:invoke', '2026-10-01', '2026-11-01')
        `.execute(trx);
      }, { revision: previous });
      const legacyBefore = (await sql`SELECT * FROM preview_drive_grants`.execute(db)).rows;
      const legacyIndexesBefore = (await sql`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'preview_drive_grants' ORDER BY indexname
      `.execute(db)).rows;

      await expect(runPlatformMigration(db, migratePlatformSchema, {
        revision: PLATFORM_SCHEMA_REVISION,
      })).resolves.toBeUndefined();
      expect(PLATFORM_SCHEMA_REVISION.generation).toBe(8);
      const marker = await sql<{ generation: number; fingerprint: string }>`
        SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'core'
      `.execute(db);
      expect(marker.rows).toEqual([PLATFORM_SCHEMA_REVISION]);
      const retained = await sql<{
        enabled: boolean; allowed_model_ids: string; next_background_issue_at: string;
        credit_balance_microusd: string; request_class: string; actor_id: string;
      }>`
        SELECT policy.enabled, policy.allowed_model_ids, policy.next_background_issue_at,
          balance.credit_balance_microusd::text, credential.request_class, grant_row.actor_id
        FROM ai_funded_runtime_policies policy
        JOIN ai_funded_runtime_balances balance USING (machine_id)
        JOIN ai_runtime_credentials credential USING (machine_id)
        CROSS JOIN preview_drive_grants grant_row
      `.execute(db);
      expect(retained.rows).toEqual([{
        enabled: true, allowed_model_ids: '["managed-model"]',
        next_background_issue_at: "1970-01-01T00:00:00.000Z",
        credit_balance_microusd: "123456", request_class: "interactive", actor_id: "owner",
      }]);
      const claims = await sql<{ name: string }>`
        SELECT to_regclass('ai_funded_priority_claims')::text AS name
      `.execute(db);
      expect(claims.rows[0]?.name).toBe("ai_funded_priority_claims");
      expect((await sql`SELECT * FROM preview_drive_grants`.execute(db)).rows).toEqual(legacyBefore);
      expect((await sql`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'preview_drive_grants' ORDER BY indexname
      `.execute(db)).rows).toEqual(legacyIndexesBefore);

      const skipped = vi.fn(async () => { throw new Error("completed migration must skip"); });
      await runPlatformMigration(db, skipped, { revision: PLATFORM_SCHEMA_REVISION });
      await runPlatformMigration(db, skipped, { revision: previous });
      await expect(runPlatformMigration(db, skipped, {
        revision: { generation: 8, fingerprint: "conflicting-branch" },
      })).rejects.toThrow("Conflicting platform schema fingerprints");
      expect(skipped).not.toHaveBeenCalled();
      expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions`.execute(db)).rows)
        .toEqual([PLATFORM_SCHEMA_REVISION]);
    } finally { await db.destroy(); }
  });
});
