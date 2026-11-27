import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { KyselyPGlite } from "kysely-pglite";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

describe("ChatRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await createTestPGlite();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("bootstraps every canonical Chat table and index idempotently", async () => {
    await repository.bootstrap();
    const tables = await repository.kysely
      .selectFrom("information_schema.tables")
      .select("table_name")
      .where("table_schema", "=", "public")
      .where("table_name", "like", "chat%")
      .execute();

    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "chat_approval_outcomes",
      "chat_attachments",
      "chat_claude_native_recovery",
      "chat_credentials",
      "chat_deletions",
      "chat_drive_projects",
      "chat_import_jobs",
      "chat_import_messages",
      "chat_legacy_imports",
      "chat_members",
      "chat_messages",
      "chat_migrations",
      "chat_outbox",
      "chat_project_setups",
      "chat_queued_turns",
      "chat_run_adapter_state",
      "chat_run_events",
      "chat_run_steers",
      "chat_runs",
      "chat_schema_migrations",
      "chat_side_messages",
      "chat_side_threads",
      "chat_terminal_bindings",
      "chat_turns",
      "chat_user_state",
      "chats",
    ]);
    const setupIndexes = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'chat_project_setups'
    `.execute(repository.kysely);
    expect(setupIndexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexname: "chat_project_setups_pkey", indexdef: expect.stringMatching(/UNIQUE INDEX.*\(owner_id, project_id, root_fingerprint\)/i) }),
      expect.objectContaining({ indexname: "chat_project_setups_chat_id_key", indexdef: expect.stringMatching(/UNIQUE INDEX.*\(chat_id\)/i) }),
    ]));
    const activityIndex = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_run_events_run_occurred'
    `.execute(repository.kysely);
    expect(activityIndex.rows).toEqual([{ indexname: "idx_chat_run_events_run_occurred" }]);
    const sequenceIndex = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_run_events_run_sequence'
    `.execute(repository.kysely);
    expect(sequenceIndex.rows).toEqual([
      expect.objectContaining({ indexdef: expect.stringMatching(/UNIQUE INDEX.*run_id.*run_seq/i) }),
    ]);
    const recoveryIndex = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_claude_native_recovery_released'
    `.execute(repository.kysely);
    expect(recoveryIndex.rows).toEqual([
      expect.objectContaining({ indexdef: expect.stringMatching(/\(owner_id, deadline_at, chat_id\).*WHERE.*status = 'released'/i) }),
    ]);
  });
});
