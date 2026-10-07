import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { ChatConflictError, ChatNotFoundError } from "../../packages/gateway/src/chat/errors.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createProjectChatAssignmentCoordinator } from "../../packages/gateway/src/collaboration/project-chat-assignment.js";
import { PROJECT_CHAT_ROUTE_EVENT, readProjectOverview } from "../../packages/gateway/src/collaboration/project-chat-routes.js";
import {
  allowAllOrganizationPrecondition,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const OWNER_ID = "user_project_owner";
const MEMBER_ID = "user_project_member";
const OWNER = { type: "personal" as const, ownerId: OWNER_ID };
const PROJECT_ID = "project_alpha";
const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000a71";
const ORGANIZATION_ID = "org_matrix_team";
const RUNTIME_ID = "vps:runtime_project_shared";
const NOW = new Date("2026-10-05T15:00:00.000Z");

describe("shared project Chat assignment", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;
  let sequence: number;
  let endedScopes: string[];

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: PROJECT_SCOPE, owner_type: "personal", owner_id: OWNER_ID, organization_id: ORGANIZATION_ID,
      kind: "project", resource_id: PROJECT_ID, parent_scope_id: null, membership_mode: "direct",
      lifecycle: "shared", revision: 4, auth_epoch: 1, authority_runtime_id: RUNTIME_ID,
      authority_generation: 2, execution_generation: null, execution_eligibility: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: PROJECT_SCOPE, actor_id: OWNER_ID, role: "owner", status: "accepted",
      organization_id: ORGANIZATION_ID, invitation_id: null, invited_by: OWNER_ID,
      accepted_at: NOW, expires_at: null, revision: 1, joined_at: NOW,
      updated_at: NOW, dispositioned_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: PROJECT_SCOPE, actor_id: MEMBER_ID, role: "editor", status: "accepted",
      organization_id: ORGANIZATION_ID, invitation_id: null, invited_by: OWNER_ID,
      accepted_at: NOW, expires_at: null, revision: 1, joined_at: NOW,
      updated_at: NOW, dispositioned_at: null,
    }).execute();
    sequence = 1;
    endedScopes = [];
  });

  afterEach(async () => {
    await repository.release();
    await fixture.destroy();
  });

  function coordinator() {
    return createProjectChatAssignmentCoordinator({
      db: fixture.db,
      chatRepository: repository,
      now: () => NOW,
      shouldContinue: () => true,
      createBindingId: () => `30000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      createScopeId: () => `40000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      onScopeEnded: (scopeId) => { endedScopes.push(scopeId); },
    });
  }

  function service(assignments = coordinator()) {
    return createCanonicalChatService(repository, {
      projectAssignments: assignments,
      executionRoots: {
        resolve: async (_owner, ref) => ({
          ref, primaryWorkspaceRoot: "/home/matrix/home/projects/alpha",
          projectSlug: PROJECT_ID, fingerprint: "a".repeat(64),
        }),
      },
    });
  }

  function collaborationAccess() {
    const capabilities = new CollaborationCapabilityRepository(fixture.db, {
      now: () => NOW,
      createId: () => "70000000-0000-4000-8000-000000000a71",
    });
    const authority = new CollaborationAuthority(new CollaborationRepository(fixture.db, { now: () => NOW }), {
      now: () => NOW,
      organizationPrecondition: allowAllOrganizationPrecondition,
      capabilities,
    });
    const adapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      now: () => NOW,
      createId: () => "50000000-0000-4000-8000-000000000a72",
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId === MEMBER_ID ? "Project member" : "Project owner" }),
    });
    return { authority, adapter };
  }

  it("atomically binds and routes a Chat created in an already-shared project", async () => {
    const created = await service().create(OWNER, {
      clientRequestId: "req_shared_project_create",
      title: "Release plan",
      projectId: PROJECT_ID,
    });

    const binding = await fixture.db.selectFrom("collaboration_resource_bindings as binding")
      .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
      .select(["binding.project_scope_id", "binding.resource_id", "child.id as scope_id", "child.lifecycle"])
      .where("binding.resource_kind", "=", "chat").where("binding.resource_id", "=", created.chat.id)
      .executeTakeFirstOrThrow();
    expect(binding).toMatchObject({ project_scope_id: PROJECT_SCOPE, resource_id: created.chat.id, lifecycle: "shared" });
    expect(await fixture.db.selectFrom("collaboration_events").select("event_type")
      .where("scope_id", "=", binding.scope_id).where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute())
      .toHaveLength(1);
    await expect(readProjectOverview(fixture.db, { scopeId: PROJECT_SCOPE, projectName: async () => "Alpha" }))
      .resolves.toMatchObject({ chats: [expect.objectContaining({ chatId: created.chat.id, title: "Release plan" })] });
    expect((await repository.get(OWNER, created.chat.id))?.chat.revision).toBe(created.chat.revision);
  });

  it("lets an accepted project member read and write the canonical inherited Chat", async () => {
    const created = await service().create(OWNER, {
      clientRequestId: "req_shared_project_transcript",
      title: "Canonical transcript",
      projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes")
      .select(["id", "revision"])
      .where("kind", "=", "chat")
      .where("resource_id", "=", created.chat.id)
      .executeTakeFirstOrThrow();
    await fixture.db.insertInto("chat_messages").values({
      id: "msg_project_transcript", chat_id: created.chat.id, seq: 1,
      role: "user", state: "committed", turn_id: null, run_id: null,
      actor_id: OWNER_ID, purpose: "ai_request",
      parts: JSON.stringify([{ type: "text", text: "Keep this canonical." }]),
      byte_count: 64, search_text: "Keep this canonical.", created_at: NOW,
    }).execute();
    await fixture.db.updateTable("chats").set({ message_count: 1 })
      .where("id", "=", created.chat.id).execute();
    const { authority, adapter } = collaborationAccess();
    const context = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "read" });

    await expect(adapter.getChat(context)).resolves.toMatchObject({
      id: created.chat.id,
      scopeId: child.id,
      messageCount: "1",
    });
    await expect(adapter.listMessages(context, { afterSequence: "0", limit: 100 }))
      .resolves.toMatchObject([{
        id: "msg_project_transcript",
        chatId: created.chat.id,
        parts: [{ type: "text", text: "Keep this canonical." }],
      }]);
    const writer = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "discuss" });
    await expect(adapter.appendDiscussion(writer, {
      clientRequestId: "60000000-0000-4000-8000-000000000a72",
      expectedRevision: String(child.revision),
      text: "Shared project note",
    })).resolves.toMatchObject({
      chatId: created.chat.id,
      sequence: "2",
      actor: { actorId: MEMBER_ID, displayName: "Project member" },
    });
    await expect(adapter.updateDiscussionUserState(context, { readThroughSeq: "2" }))
      .resolves.toMatchObject({ readThroughSeq: "2" });
    await expect(adapter.updateUserState(context, { readThroughSeq: "2", pinned: true }))
      .resolves.toMatchObject({ readThroughSeq: "2", pinned: true });
  });

  it("lets a directly granted project contributor read and discuss in an inherited Chat", async () => {
    const created = await service().create(OWNER, {
      clientRequestId: "req_direct_grant_project_transcript",
      title: "Direct grant transcript",
      projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes")
      .select(["id", "revision"])
      .where("kind", "=", "chat")
      .where("resource_id", "=", created.chat.id)
      .executeTakeFirstOrThrow();
    await fixture.db.deleteFrom("collaboration_members")
      .where("scope_id", "=", PROJECT_SCOPE)
      .where("actor_id", "=", MEMBER_ID)
      .execute();
    await fixture.db.insertInto("collaboration_grants").values({
      id: "70000000-0000-4000-8000-000000000a71",
      scope_id: PROJECT_SCOPE,
      organization_id: ORGANIZATION_ID,
      audience_kind: "member",
      audience_actor_id: MEMBER_ID,
      preset: "contributor",
      state: "active",
      policy_version: "v1",
      source_id: null,
      legacy_ceiling: null,
      expires_at: null,
      revision: 1,
      created_by: OWNER_ID,
      created_at: NOW,
      updated_at: NOW,
      revoked_at: null,
    }).execute();
    const { authority, adapter } = collaborationAccess();
    const reader = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "read" });

    await expect(adapter.getChat(reader)).resolves.toMatchObject({
      id: created.chat.id,
      scopeId: child.id,
    });
    const writer = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "discuss" });
    await expect(adapter.appendDiscussion(writer, {
      clientRequestId: "60000000-0000-4000-8000-000000000a74",
      expectedRevision: String(child.revision),
      text: "Direct grant note",
    })).resolves.toMatchObject({
      chatId: created.chat.id,
      actor: { actorId: MEMBER_ID, displayName: "Project member" },
    });
    await fixture.db.updateTable("collaboration_grants")
      .set({ state: "revoked", revoked_at: NOW })
      .where("id", "=", "70000000-0000-4000-8000-000000000a71")
      .execute();
    await expect(adapter.getChat(reader)).rejects.toMatchObject({ code: "not_found" });
    await expect(adapter.getUserState(reader)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an inherited Chat whose resource binding is blocked", async () => {
    const created = await service().create(OWNER, {
      clientRequestId: "req_shared_project_blocked_binding",
      projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes").select("id")
      .where("kind", "=", "chat").where("resource_id", "=", created.chat.id).executeTakeFirstOrThrow();
    await fixture.db.updateTable("collaboration_resource_bindings")
      .set({ readiness: "blocked", blocker: "test_blocked" })
      .where("resource_scope_id", "=", child.id).execute();
    const { authority, adapter } = collaborationAccess();
    const context = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "read" });

    await expect(adapter.getChat(context)).rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.updateUserState(context, { pinned: true }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects an inherited Chat whose binding authority does not match its scope", async () => {
    const created = await service().create(OWNER, {
      clientRequestId: "req_shared_project_mismatched_binding",
      projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes").select("id")
      .where("kind", "=", "chat").where("resource_id", "=", created.chat.id).executeTakeFirstOrThrow();
    await fixture.db.updateTable("collaboration_resource_bindings")
      .set({ authority_generation: 3 })
      .where("resource_scope_id", "=", child.id).execute();
    const { authority, adapter } = collaborationAccess();
    const reader = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "read" });
    const writer = await authority.authorize({ scopeId: child.id, actorId: MEMBER_ID, action: "discuss" });

    await expect(adapter.getChat(reader)).rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.appendDiscussion(writer, {
      clientRequestId: "60000000-0000-4000-8000-000000000a73",
      expectedRevision: "0",
      text: "Do not accept mismatched authority",
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.updateDiscussionUserState(reader, { readThroughSeq: "0" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("rolls the Chat creation back when its inherited binding cannot commit", async () => {
    const assignments = createProjectChatAssignmentCoordinator({
      db: fixture.db, chatRepository: repository, now: () => NOW,
      createScopeId: () => "not-a-uuid", shouldContinue: () => true,
    });

    await expect(service(assignments).create(OWNER, {
      clientRequestId: "req_atomic_failure", projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: "unavailable" });
    expect(await fixture.db.selectFrom("chats").select("id")
      .where("create_request_id", "=", "req_atomic_failure").executeTakeFirst()).toBeUndefined();
  });

  it("binds a Chat moved in and ends its inherited scope when moved out", async () => {
    const chatService = service();
    const created = await chatService.create(OWNER, { clientRequestId: "req_move_chat" });
    const movedIn = await chatService.updateProject(OWNER, created.chat.id, {
      baseRevision: created.chat.revision, projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes").select(["id", "lifecycle"])
      .where("kind", "=", "chat").where("resource_id", "=", created.chat.id)
      .where("deleted_at", "is", null).executeTakeFirstOrThrow();
    expect(child.lifecycle).toBe("shared");
    expect(await fixture.db.selectFrom("collaboration_events").select("event_type")
      .where("scope_id", "=", child.id).where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute())
      .toHaveLength(1);

    const movedOut = await chatService.updateProject(OWNER, created.chat.id, {
      baseRevision: movedIn.chat.revision, projectId: null,
    });
    expect(movedOut.projectId).toBeUndefined();
    expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("id")
      .where("resource_id", "=", created.chat.id).execute()).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_scopes").select(["lifecycle", "deleted_at"])
      .where("id", "=", child.id).executeTakeFirstOrThrow()).toMatchObject({ lifecycle: "deleted", deleted_at: NOW });
    expect(await fixture.db.selectFrom("collaboration_events").select("event_type")
      .where("scope_id", "=", child.id).where("event_type", "=", "scope.deleted").execute())
      .toHaveLength(1);
    expect(endedScopes).toEqual([child.id]);
  });

  it("reparents a directly shared Chat when it moves into a shared project", async () => {
    const directScopeId = "50000000-0000-4000-8000-000000000a71";
    const created = await repository.create(OWNER, {
      id: "chat_direct_move", clientRequestId: "req_direct_move", title: "Direct Chat",
    });
    await fixture.db.insertInto("collaboration_scopes").values({
      id: directScopeId, owner_type: "personal", owner_id: OWNER_ID, organization_id: ORGANIZATION_ID,
      kind: "chat", resource_id: created.chat.id, parent_scope_id: null, membership_mode: "direct",
      lifecycle: "shared", revision: 3, auth_epoch: 2, authority_runtime_id: "vps:direct_chat",
      authority_generation: 1, execution_generation: null, execution_eligibility: null,
      created_at: NOW, updated_at: NOW, deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: directScopeId, actor_id: "user_previous_recipient", role: "viewer", status: "accepted",
      organization_id: ORGANIZATION_ID, invitation_id: null, invited_by: OWNER_ID, accepted_at: NOW,
      expires_at: null, revision: 1, joined_at: NOW, updated_at: NOW, dispositioned_at: null,
    }).execute();
    const queuedTurn = (id: string, position: number, collaborationScopeId: string | null) => ({
      id, chat_id: created.chat.id, client_request_id: `req_${id}`,
      requesting_actor_id: collaborationScopeId ? "user_previous_recipient" : null,
      collaboration_scope_id: collaborationScopeId, position, status: "queued" as const,
      parts: JSON.stringify([{ type: "text", text: id }]), driver_kind: "claude",
      instance_id: "default", selection: JSON.stringify({ instanceId: "claude_default", model: "claude-opus-4-6" }),
      interaction_mode: "chat", permission_mode: "default", capability_snapshot: "{}",
      created_at: NOW, updated_at: NOW,
    });
    await fixture.db.insertInto("chat_queued_turns").values([
      queuedTurn("qturn_direct_old", 1, directScopeId),
      queuedTurn("qturn_owner_current", 2, null),
    ]).execute();

    await expect(service().updateProject(OWNER, created.chat.id, {
      baseRevision: created.chat.revision, projectId: PROJECT_ID,
    })).resolves.toMatchObject({ projectId: PROJECT_ID });

    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["parent_scope_id", "membership_mode", "lifecycle", "authority_runtime_id"])
      .where("id", "=", directScopeId).executeTakeFirstOrThrow()).toMatchObject({
      parent_scope_id: PROJECT_SCOPE,
      membership_mode: "inherited",
      lifecycle: "shared",
      authority_runtime_id: RUNTIME_ID,
    });
    expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("resource_scope_id")
      .where("project_scope_id", "=", PROJECT_SCOPE).where("resource_id", "=", created.chat.id)
      .executeTakeFirstOrThrow()).toEqual({ resource_scope_id: directScopeId });
    expect(await fixture.db.selectFrom("collaboration_members").select("actor_id")
      .where("scope_id", "=", directScopeId).execute()).toEqual([]);
    expect(await fixture.db.selectFrom("chat_queued_turns").select(["id", "position", "status"])
      .where("chat_id", "=", created.chat.id).orderBy("id").execute()).toEqual([
      { id: "qturn_direct_old", position: 1, status: "cancelled" },
      { id: "qturn_owner_current", position: 1, status: "queued" },
    ]);
    expect(endedScopes).toEqual([directScopeId]);
  });

  it("compacts remaining queued turns when a Chat moves out of a shared project", async () => {
    const chatService = service();
    const created = await chatService.create(OWNER, {
      clientRequestId: "req_queue_compaction", projectId: PROJECT_ID,
    });
    const child = await fixture.db.selectFrom("collaboration_scopes").select("id")
      .where("kind", "=", "chat").where("resource_id", "=", created.chat.id)
      .where("deleted_at", "is", null).executeTakeFirstOrThrow();
    const queuedTurn = (id: string, position: number, collaborationScopeId: string | null) => ({
      id, chat_id: created.chat.id, client_request_id: `req_${id}`,
      requesting_actor_id: collaborationScopeId ? "user_collaborator" : null,
      collaboration_scope_id: collaborationScopeId, position, status: "queued" as const,
      parts: JSON.stringify([{ type: "text", text: id }]), driver_kind: "claude",
      instance_id: "default", selection: JSON.stringify({ instanceId: "claude_default", model: "claude-opus-4-6" }),
      interaction_mode: "chat", permission_mode: "default", capability_snapshot: "{}",
      created_at: NOW, updated_at: NOW,
    });
    await fixture.db.insertInto("chat_queued_turns").values([
      queuedTurn("qturn_shared_first", 1, child.id),
      queuedTurn("qturn_personal_middle", 2, null),
      queuedTurn("qturn_shared_last", 3, child.id),
    ]).execute();

    await chatService.updateProject(OWNER, created.chat.id, {
      baseRevision: created.chat.revision, projectId: null,
    });

    expect(await fixture.db.selectFrom("chat_queued_turns").select(["id", "position", "status"])
      .where("chat_id", "=", created.chat.id).orderBy("id").execute()).toEqual([
      { id: "qturn_personal_middle", position: 1, status: "queued" },
      { id: "qturn_shared_first", position: 1, status: "cancelled" },
      { id: "qturn_shared_last", position: 3, status: "cancelled" },
    ]);
  });

  it("preserves canonical Chat errors when assignment reconciliation is enabled", async () => {
    const chatService = service();
    const created = await chatService.create(OWNER, { clientRequestId: "req_error_mapping" });

    await expect(chatService.updateProject(OWNER, created.chat.id, {
      baseRevision: created.chat.revision + 1, projectId: PROJECT_ID,
    })).rejects.toBeInstanceOf(ChatConflictError);
    await expect(chatService.updateProject(OWNER, "chat_missing_assignment", {
      baseRevision: 0, projectId: PROJECT_ID,
    })).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it("backfills missing bindings in bounded idempotent passes", async () => {
    const created = await repository.create(OWNER, {
      id: "chat_existing_unbound", clientRequestId: "req_existing_unbound",
      title: "Existing Chat", projectId: PROJECT_ID,
    });
    const assignments = coordinator();

    await expect(assignments.backfill()).resolves.toBe(1);
    await expect(assignments.backfill()).resolves.toBe(0);
    await expect(readProjectOverview(fixture.db, { scopeId: PROJECT_SCOPE, projectName: async () => "Alpha" }))
      .resolves.toMatchObject({ chats: [expect.objectContaining({ chatId: created.chat.id })] });
    expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("id")
      .where("resource_kind", "=", "chat").where("resource_id", "=", created.chat.id).execute())
      .toHaveLength(1);
  });

  it("continues startup repair after a blocked Chat", async () => {
    const blocked = await repository.create(OWNER, {
      id: "chat_a_blocked", clientRequestId: "req_backfill_blocked",
      title: "Blocked", projectId: PROJECT_ID,
    });
    const eligible = await repository.create(OWNER, {
      id: "chat_b_eligible", clientRequestId: "req_backfill_eligible",
      title: "Eligible", projectId: PROJECT_ID,
    });
    await fixture.db.insertInto("chat_queued_turns").values({
      id: "qturn_company_drive", chat_id: blocked.chat.id, client_request_id: "req_queue_company_drive",
      position: 1, status: "cancelled",
      parts: JSON.stringify([{ type: "resource_reference", resource: { kind: "organization_drive" } }]),
      driver_kind: "claude-code", instance_id: "default",
      selection: JSON.stringify({ instanceId: "claude_default", model: "claude-opus-4-6" }),
      interaction_mode: "default", permission_mode: "supervised", capability_snapshot: "{}",
      created_at: NOW, updated_at: NOW,
    }).execute();

    await expect(coordinator().backfill()).resolves.toBe(1);
    expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("resource_id")
      .where("project_scope_id", "=", PROJECT_SCOPE).orderBy("resource_id").execute())
      .toEqual([{ resource_id: eligible.chat.id }]);
  });

  it("stops the backfill before claiming another batch during shutdown", async () => {
    const assignments = createProjectChatAssignmentCoordinator({
      db: fixture.db, chatRepository: repository, shouldContinue: () => false,
    });
    await repository.create(OWNER, {
      id: "chat_shutdown_unbound", clientRequestId: "req_shutdown_unbound",
      title: "Shutdown", projectId: PROJECT_ID,
    });

    await expect(assignments.backfill()).resolves.toBe(0);
    expect(await fixture.db.selectFrom("collaboration_resource_bindings").select("id").execute()).toEqual([]);
  });
});
