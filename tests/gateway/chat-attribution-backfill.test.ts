import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_attribution_repair" };
const importedOwner = { type: "personal" as const, ownerId: "owner_imported" };
const organization = { type: "organization" as const, ownerId: "org_attribution" };
const createdAt = "2026-09-17T00:00:00.000Z";
const sharedScopeId = "11111111-2222-4333-8444-555555555555";
const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
const capabilitySnapshot = {
  revision: "catalog_repair",
  rootChat: true,
  attachments: [],
  resources: [],
  tools: [],
  approvals: true,
  userInput: true,
  resume: true,
  cancellation: true,
  steering: "same_run" as const,
  worktrees: "optional" as const,
  interactionModes: ["default"],
  permissionModes: ["supervised"],
};

describe("canonical Chat owner attribution repair", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("repairs only provably owner-authored personal AI prompts", async () => {
    await repository.create(owner, {
      id: "chat_repair_owner",
      clientRequestId: "req_create_repair_owner",
      title: "Owner prompts",
    });
    await repository.create(importedOwner, {
      id: "chat_repair_imported",
      clientRequestId: "req_create_repair_imported",
      title: "Imported prompts",
    });
    await repository.create(organization, {
      id: "chat_repair_org",
      clientRequestId: "req_create_repair_org",
      title: "Organization prompts",
    });

    await seedTurn("chat_repair_owner", "owner_direct", 1);
    await seedTurn("chat_repair_owner", "owner_queued", 2, {
      queuedTurnId: "qturn_owner_repair",
      requestingActorId: null,
    });
    await seedTurn("chat_repair_owner", "shared_editor", 3, {
      queuedTurnId: "qturn_editor_repair",
      requestingActorId: "user_shared_editor",
      collaborationScopeId: sharedScopeId,
    });
    await repository.kysely.insertInto("chat_run_steers").values({
      id: "steer_failed_before_shared_editor_claim",
      chat_id: "chat_repair_owner",
      run_id: "run_owner_direct",
      turn_id: "cturn_owner_direct",
      client_request_id: "req_failed_before_shared_editor_claim",
      message_id: "msg_failed_before_shared_editor_claim",
      queued_turn_id: "qturn_editor_repair",
      parts: JSON.stringify([{ type: "text", text: "failed before later claim" }]),
      status: "failed",
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
    await seedTurn("chat_repair_owner", "ambiguous_shared_queue", 4, {
      queuedTurnId: "qturn_ambiguous_shared_repair",
      requestingActorId: null,
      collaborationScopeId: sharedScopeId,
    });
    await seedSteer("chat_repair_owner", "owner_steer", 5, "cturn_owner_direct", "run_owner_direct");
    await seedSteer("chat_repair_owner", "ambiguous_shared_steer", 6, "cturn_owner_direct", "run_owner_direct", {
      queuedTurnId: "qturn_ambiguous_shared_steer_repair",
      collaborationScopeId: sharedScopeId,
    });
    await seedLooseMessage("chat_repair_owner", "ambiguous", 7, "user", "ai_request");
    await seedLooseMessage("chat_repair_owner", "discussion", 8, "user", "discussion");
    await seedLooseMessage("chat_repair_owner", "system_user", 9, "user", "system");
    await seedLooseMessage("chat_repair_owner", "assistant", 10, "assistant", "assistant");
    await seedLooseMessage("chat_repair_owner", "tool", 11, "tool", "system");
    await seedLooseMessage("chat_repair_owner", "system", 12, "system", "system");

    await seedTurn("chat_repair_imported", "imported", 1);
    await repository.kysely.insertInto("chat_legacy_imports").values({
      owner_type: "personal",
      owner_id: importedOwner.ownerId,
      source_kind: "coding_thread",
      source_id: "legacy_imported_prompt",
      chat_id: "chat_repair_imported",
      source_hash: "a".repeat(64),
      import_version: 1,
      verification_status: "verified",
    }).execute();
    await seedTurn("chat_repair_org", "organization", 1);

    // The owner prompt remains attributable after the Chat is shared; current
    // collaboration state is not authorship provenance.
    await repository.kysely.updateTable("chats").set({
      collaboration: {
        mode: "discussion_only",
        scopeId: sharedScopeId,
        executionFenced: true,
        authorityGeneration: 1,
      },
    }).where("id", "=", "chat_repair_owner").execute();

    await repository.kysely.deleteFrom("chat_schema_migrations").where("version", "=", 2).execute();
    await repository.bootstrap();
    await repository.bootstrap();

    const rows = await repository.kysely.selectFrom("chat_messages")
      .select(["id", "actor_id", "purpose"])
      .orderBy("id")
      .execute();
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    for (const id of ["msg_owner_direct", "msg_owner_queued", "msg_owner_steer"]) {
      expect(byId[id]).toMatchObject({ actor_id: owner.ownerId, purpose: "ai_request" });
    }
    for (const id of [
      "msg_shared_editor",
      "msg_ambiguous_shared_queue",
      "msg_ambiguous_shared_steer",
      "msg_ambiguous",
      "msg_discussion",
      "msg_system_user",
      "msg_assistant",
      "msg_tool",
      "msg_system",
      "msg_imported",
      "msg_organization",
    ]) {
      expect(byId[id]?.actor_id, id).toBeNull();
    }
    expect(byId.msg_discussion?.purpose).toBe("discussion");
    expect(byId.msg_system_user?.purpose).toBe("system");
    expect(await repository.kysely.selectFrom("chat_schema_migrations")
      .select("version").where("version", "=", 2).execute()).toEqual([{ version: 2 }]);
  });

  async function seedTurn(
    chatId: string,
    suffix: string,
    seq: number,
    queued?: {
      queuedTurnId: string;
      requestingActorId: string | null;
      collaborationScopeId?: string;
    },
  ) {
    const messageId = `msg_${suffix}`;
    const turnId = `cturn_${suffix}`;
    const runId = `run_${suffix}`;
    await repository.kysely.insertInto("chat_messages").values({
      id: messageId,
      chat_id: chatId,
      seq,
      role: "user",
      state: "committed",
      turn_id: turnId,
      run_id: null,
      actor_id: null,
      purpose: "ai_request",
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      byte_count: suffix.length,
      search_text: suffix,
      created_at: createdAt,
    }).execute();
    await repository.kysely.insertInto("chat_turns").values({
      id: turnId,
      chat_id: chatId,
      client_request_id: `req_${suffix}`,
      base_message_seq: seq - 1,
      input_message_id: messageId,
      status: "completed",
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
    await repository.kysely.insertInto("chat_runs").values({
      id: runId,
      chat_id: chatId,
      turn_id: turnId,
      client_request_id: `req_${suffix}`,
      attempt: 1,
      driver_kind: "codex",
      instance_id: "codex_default",
      selection: JSON.stringify(selection),
      interaction_mode: "default",
      permission_mode: "supervised",
      execution_root: null,
      execution_root_fingerprint: null,
      status: "completed",
      outcome: "completed",
      started_at: createdAt,
      completed_at: createdAt,
      history_boundary_seq: seq - 1,
      capability_snapshot: JSON.stringify(capabilitySnapshot),
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
    if (!queued) return;
    await repository.kysely.insertInto("chat_queued_turns").values({
      id: queued.queuedTurnId,
      chat_id: chatId,
      client_request_id: `req_${suffix}`,
      actor_request_id: queued.collaborationScopeId ? `actor_req_${suffix}` : null,
      requesting_actor_id: queued.requestingActorId,
      collaboration_scope_id: queued.collaborationScopeId ?? null,
      accepted_seq: queued.collaborationScopeId ? seq : null,
      payload_hash: queued.collaborationScopeId ? "b".repeat(64) : null,
      accepted_auth_epoch: queued.collaborationScopeId ? 1 : null,
      retry_of_queued_turn_id: null,
      position: 1,
      status: "claimed",
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      driver_kind: "codex",
      instance_id: "codex_default",
      selection: JSON.stringify(selection),
      interaction_mode: "default",
      permission_mode: "supervised",
      execution_root: null,
      execution_root_fingerprint: null,
      capability_snapshot: JSON.stringify(capabilitySnapshot),
      claimed_turn_id: turnId,
      claimed_run_id: runId,
      cancelled_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
  }

  async function seedSteer(
    chatId: string,
    suffix: string,
    seq: number,
    turnId: string,
    runId: string,
    queued?: { queuedTurnId: string; collaborationScopeId: string },
  ) {
    const messageId = `msg_${suffix}`;
    await repository.kysely.insertInto("chat_messages").values({
      id: messageId,
      chat_id: chatId,
      seq,
      role: "user",
      state: "committed",
      turn_id: turnId,
      run_id: runId,
      actor_id: null,
      purpose: "ai_request",
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      byte_count: suffix.length,
      search_text: suffix,
      created_at: createdAt,
    }).execute();
    if (queued) {
      await repository.kysely.insertInto("chat_queued_turns").values({
        id: queued.queuedTurnId,
        chat_id: chatId,
        client_request_id: `req_queue_${suffix}`,
        actor_request_id: `actor_req_${suffix}`,
        requesting_actor_id: null,
        collaboration_scope_id: queued.collaborationScopeId,
        accepted_seq: seq,
        payload_hash: "c".repeat(64),
        accepted_auth_epoch: 1,
        retry_of_queued_turn_id: null,
        position: 1,
        status: "claimed",
        parts: JSON.stringify([{ type: "text", text: suffix }]),
        driver_kind: "codex",
        instance_id: "codex_default",
        selection: JSON.stringify(selection),
        interaction_mode: "default",
        permission_mode: "supervised",
        execution_root: null,
        execution_root_fingerprint: null,
        capability_snapshot: JSON.stringify(capabilitySnapshot),
        claimed_turn_id: turnId,
        claimed_run_id: runId,
        cancelled_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      }).execute();
    }
    await repository.kysely.insertInto("chat_run_steers").values({
      id: `steer_${suffix}`,
      chat_id: chatId,
      run_id: runId,
      turn_id: turnId,
      client_request_id: `req_${suffix}`,
      message_id: messageId,
      queued_turn_id: queued?.queuedTurnId ?? null,
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      status: "accepted",
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
  }

  async function seedLooseMessage(
    chatId: string,
    suffix: string,
    seq: number,
    role: "user" | "assistant" | "tool" | "system",
    purpose: "discussion" | "ai_request" | "assistant" | "system",
  ) {
    await repository.kysely.insertInto("chat_messages").values({
      id: `msg_${suffix}`,
      chat_id: chatId,
      seq,
      role,
      state: "committed",
      turn_id: null,
      run_id: null,
      actor_id: null,
      purpose,
      parts: JSON.stringify([{ type: "text", text: suffix }]),
      byte_count: suffix.length,
      search_text: suffix,
      created_at: createdAt,
    }).execute();
  }
});
