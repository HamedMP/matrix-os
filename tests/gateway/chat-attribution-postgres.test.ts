import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapChatAttribution } from "../../packages/gateway/src/chat/attribution-repair.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import {
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const createdAt = "2026-09-17T00:00:00.000Z";
const sharedScopeId = "11111111-2222-4333-8444-555555555555";

realDescribe("canonical Chat attribution repair on PostgreSQL", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    repository = new ChatRepository(fixture.db);
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("serializes the versioned repair and leaves imported prompts unattributed", async () => {
    await repository.create(
      { type: "personal", ownerId: "owner_real_repair" },
      { id: "chat_real_repair", clientRequestId: "req_real_repair", title: "Repair" },
    );
    await repository.create(
      { type: "personal", ownerId: "owner_real_import" },
      { id: "chat_real_import", clientRequestId: "req_real_import", title: "Imported" },
    );
    await seedCanonicalInput("chat_real_repair", "real_repair");
    await seedCanonicalInput("chat_real_import", "real_import");
    await fixture.db.insertInto("chat_legacy_imports").values({
      owner_type: "personal",
      owner_id: "owner_real_import",
      source_kind: "coding_thread",
      source_id: "legacy_real_import",
      chat_id: "chat_real_import",
      source_hash: "c".repeat(64),
      import_version: 1,
      verification_status: "verified",
    }).execute();
    await fixture.db.updateTable("chats").set({
      collaboration: {
        mode: "discussion_only",
        scopeId: sharedScopeId,
        executionFenced: true,
        authorityGeneration: 1,
      },
    }).where("id", "=", "chat_real_repair").execute();

    await fixture.db.deleteFrom("chat_schema_migrations").where("version", "=", 2).execute();
    await Promise.all([
      bootstrapChatAttribution(fixture.db),
      bootstrapChatAttribution(fixture.db),
    ]);

    await expect(fixture.db.selectFrom("chat_messages")
      .select(["id", "actor_id"])
      .orderBy("id")
      .execute()).resolves.toEqual([
      { id: "msg_real_import", actor_id: null },
      { id: "msg_real_repair", actor_id: "owner_real_repair" },
    ]);
    await expect(fixture.db.selectFrom("chat_schema_migrations")
      .select("version").where("version", "=", 2).execute()).resolves.toEqual([{ version: 2 }]);
  });

  async function seedCanonicalInput(chatId: string, suffix: string) {
    await fixture.db.insertInto("chat_messages").values({
      id: `msg_${suffix}`,
      chat_id: chatId,
      seq: 1,
      role: "user",
      state: "committed",
      turn_id: `cturn_${suffix}`,
      run_id: null,
      actor_id: null,
      purpose: "ai_request",
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      byte_count: suffix.length,
      search_text: suffix,
      created_at: createdAt,
    }).execute();
    await fixture.db.insertInto("chat_turns").values({
      id: `cturn_${suffix}`,
      chat_id: chatId,
      client_request_id: `req_${suffix}`,
      base_message_seq: 0,
      input_message_id: `msg_${suffix}`,
      status: "completed",
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
    await fixture.db.insertInto("chat_runs").values({
      id: `run_${suffix}`,
      chat_id: chatId,
      turn_id: `cturn_${suffix}`,
      client_request_id: `req_${suffix}`,
      attempt: 1,
      driver_kind: "codex",
      instance_id: "codex_default",
      selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
      interaction_mode: "default",
      permission_mode: "supervised",
      execution_root: null,
      execution_root_fingerprint: null,
      status: "completed",
      outcome: "completed",
      started_at: createdAt,
      completed_at: createdAt,
      history_boundary_seq: 0,
      capability_snapshot: JSON.stringify({}),
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
  }
});
