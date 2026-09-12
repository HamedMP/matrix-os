import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

describe("collaboration owner database", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("adds every collaboration authority and transition table and index idempotently", async () => {
    await bootstrapCollaborationDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);

    const tables = await fixture.db
      .selectFrom("information_schema.tables")
      .select("table_name")
      .where("table_schema", "=", "public")
      .where("table_name", "like", "collaboration_%")
      .execute();

    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "collaboration_audit",
      "collaboration_directory_outbox",
      "collaboration_events",
      "collaboration_exports",
      "collaboration_members",
      "collaboration_operations",
      "collaboration_schema_migrations",
      "collaboration_scopes",
      "collaboration_transitions",
    ]);

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_collaboration_%'
    `.execute(fixture.db);
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual(expect.arrayContaining([
      "idx_collaboration_events_replay",
      "idx_collaboration_exports_expiry",
      "idx_collaboration_invitation_identity",
      "idx_collaboration_outbox_delivery",
      "idx_collaboration_scope_binding",
      "idx_collaboration_transition_in_progress",
      "idx_collaboration_transition_recovery",
    ]));
  });

  it("upgrades an existing canonical Chat schema with immutable attribution fields", async () => {
    await sql`ALTER TABLE chat_messages DROP COLUMN actor_id`.execute(fixture.db);
    await sql`ALTER TABLE chat_messages DROP COLUMN purpose`.execute(fixture.db);
    await bootstrapChatDatabase(fixture.db);

    const columns = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chat_messages'
        AND column_name IN ('actor_id', 'purpose')
      ORDER BY column_name
    `.execute(fixture.db);
    expect(columns.rows).toEqual([
      { column_name: "actor_id", is_nullable: "YES" },
      { column_name: "purpose", is_nullable: "NO" },
    ]);

    await expect(sql`
      INSERT INTO collaboration_scopes (
        id, owner_type, owner_id, kind, resource_id, membership_mode,
        lifecycle, authority_runtime_id
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', 'personal', 'owner',
        'chat', 'chat-one', 'inherited', 'shared', 'runtime-one'
      )
    `.execute(fixture.db)).rejects.toThrow();
  });
});
