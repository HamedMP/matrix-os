import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapPlatformCollaborationDatabase,
  type CollaborationPlatformDatabase,
} from "../../packages/platform/src/collaboration/database.js";
import { inventoryPlatformPersonToPersonRecords } from "../../packages/platform/src/collaboration/person-to-person-inventory.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("collaboration cutover on real PostgreSQL (T088)", () => {
  let adminDb: Kysely<Record<string, never>>;
  let db: Kysely<CollaborationPlatformDatabase>;
  let schema: string;

  beforeEach(async () => {
    schema = `collab_cutover_${randomUUID().replaceAll("-", "")}`;
    adminDb = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
    db = new Kysely<CollaborationPlatformDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` }),
      }),
    });
    await bootstrapPlatformCollaborationDatabase(db);
  });

  afterEach(async () => {
    await db.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
    await adminDb.destroy();
  });

  it("inventories only legacy person-to-person rows, excluding active organization shares", async () => {
    const legacyScope = randomUUID();
    const organizationScope = randomUUID();
    for (const [scopeId, organizationId] of [[legacyScope, null], [organizationScope, "org_current"]] as const) {
      await db.insertInto("collaboration_directory").values({
        scope_id: scopeId, runtime_id: "vps:owner-runtime", owner_id: "owner-a", kind: "chat",
        organization_id: organizationId, audience: organizationId ? "organization" : null,
        authority_generation: 1, metadata_revision: 1, last_event_id: randomUUID(), updated_at: new Date(),
      }).execute();
    }
    await db.insertInto("collaboration_user_index").values([
      { actor_id: "legacy-actor", scope_id: legacyScope, status: "invited", invitation_id: randomUUID(), locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
      { actor_id: "org-actor", scope_id: organizationScope, status: "accepted", invitation_id: null, locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
    ]).execute();

    expect(await inventoryPlatformPersonToPersonRecords(db)).toEqual({
      directoryScopes: 1,
      invitedIndexRows: 1,
      acceptedIndexRows: 0,
      revokedIndexRows: 0,
      total: 2,
    });
  });
});
