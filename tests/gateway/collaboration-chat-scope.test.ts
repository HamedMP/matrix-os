import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborationChatScopeError,
  CollaborationChatScopeService,
  createDiscussionOnlyChatExecutionGuard,
} from "../../packages/gateway/src/collaboration/chat-scope.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-07T12:00:00.000Z";

describe("CollaborationChatScopeService", () => {
  let fixture: CollaborationTestDatabase;
  let service: CollaborationChatScopeService;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedChat(fixture);
    service = new CollaborationChatScopeService(fixture.db, {
      runtimeId: collaborationIds.runtime,
      preflightSecret: "0123456789abcdef0123456789abcdef",
      now: () => new Date(now),
      createScopeId: () => collaborationIds.scope,
    });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("preflights and atomically converts one whole Chat to discussion-only sharing", async () => {
    const preflight = await service.preflight({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
    });
    expect(preflight).toMatchObject({ eligible: true, chatRevision: 0 });

    const scope = await service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: preflight.confirmationToken!,
    });
    expect(scope).toMatchObject({
      id: collaborationIds.scope,
      resourceId: collaborationIds.chat,
      lifecycle: "shared",
      revision: 1,
      authEpoch: 1,
    });
    const chat = await fixture.db.selectFrom("chats").select(["collaboration", "revision"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow();
    expect(chat.collaboration).toMatchObject({
      scopeId: collaborationIds.scope,
      mode: "discussion_only",
      executionFenced: true,
    });
    expect(Number(chat.revision)).toBe(1);
  });

  it("returns the existing logical scope for an idempotent retry without reusing preflight authority", async () => {
    const preflight = await service.preflight({ ownerId: collaborationActors.owner, chatId: collaborationIds.chat });
    const first = await service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: preflight.confirmationToken!,
    });
    const repeated = await service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: "expired-or-already-consumed-confirmation",
    });
    expect(repeated).toEqual(first);
  });

  it("refuses conversion while private execution is active and leaves it intact", async () => {
    await seedActiveRun(fixture);
    const preflight = await service.preflight({ ownerId: collaborationActors.owner, chatId: collaborationIds.chat });
    expect(preflight).toEqual({ eligible: false, reason: "active_work", chatRevision: 0 });
    await expect(service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: "invalid",
    })).rejects.toBeInstanceOf(CollaborationChatScopeError);
    expect(await fixture.db.selectFrom("chat_runs").select("status").executeTakeFirstOrThrow())
      .toMatchObject({ status: "running" });
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().execute()).toEqual([]);
  });

  it("does not treat a standalone Chat scope as a project or sibling grant", async () => {
    const preflight = await service.preflight({ ownerId: collaborationActors.owner, chatId: collaborationIds.chat });
    await service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: preflight.confirmationToken!,
    });
    expect(await fixture.db.selectFrom("collaboration_scopes").select([
      "kind", "resource_id", "parent_scope_id", "membership_mode",
    ]).execute()).toEqual([{
      kind: "chat",
      resource_id: collaborationIds.chat,
      parent_scope_id: null,
      membership_mode: "direct",
    }]);
  });

  it("builds an execution guard from canonical Chat state without rollout configuration", async () => {
    const guard = createDiscussionOnlyChatExecutionGuard(fixture.db);
    await expect(guard.assertPersonalExecutionAllowed(
      { type: "personal", ownerId: collaborationActors.owner },
      collaborationIds.chat,
    )).resolves.toBeUndefined();
    const preflight = await service.preflight({ ownerId: collaborationActors.owner, chatId: collaborationIds.chat });
    await service.shareChat({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
      expectedChatRevision: 0,
      confirmationToken: preflight.confirmationToken!,
    });
    await expect(guard.assertPersonalExecutionAllowed(
      { type: "personal", ownerId: collaborationActors.owner },
      collaborationIds.chat,
    )).rejects.toMatchObject({ code: "shared_execution_disabled" });
  });
});

async function seedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    create_request_id: "req_collaboration_chat",
    project_id: "project_private",
    title: "Release discussion",
    lifecycle: "active",
    attention: "none",
    collaboration: null,
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: now,
    updated_at: now,
  }).execute();
}

async function seedActiveRun(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chat_messages").values({
    id: "msg_active",
    chat_id: collaborationIds.chat,
    seq: 1,
    role: "user",
    state: "committed",
    turn_id: "cturn_active",
    run_id: null,
    actor_id: null,
    purpose: "ai_request",
    parts: JSON.stringify([{ type: "text", text: "private work" }]),
    byte_count: 12,
    search_text: "private work",
    created_at: now,
  }).execute();
  await fixture.db.insertInto("chat_turns").values({
    id: "cturn_active",
    chat_id: collaborationIds.chat,
    client_request_id: "req_active",
    base_message_seq: 0,
    input_message_id: "msg_active",
    status: "running",
    created_at: now,
    updated_at: now,
  }).execute();
  await fixture.db.insertInto("chat_runs").values({
    id: "run_active",
    chat_id: collaborationIds.chat,
    turn_id: "cturn_active",
    client_request_id: "req_run_active",
    attempt: 1,
    driver_kind: "codex",
    instance_id: "codex_default",
    selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
    interaction_mode: "default",
    permission_mode: "supervised",
    execution_root: null,
    execution_root_fingerprint: null,
    status: "running",
    outcome: null,
    started_at: now,
    completed_at: null,
    history_boundary_seq: 0,
    capability_snapshot: JSON.stringify({}),
    created_at: now,
    updated_at: now,
  }).execute();
}
