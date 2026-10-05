import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectChatAssignmentCoordinator } from "../../packages/gateway/src/collaboration/project-chat-assignment.js";
import { PROJECT_CHAT_ROUTE_EVENT, readProjectOverview } from "../../packages/gateway/src/collaboration/project-chat-routes.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const OWNER_ID = "user_project_owner";
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
