import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createCollaborationProjectLifecycle } from "../../packages/gateway/src/collaboration/project-lifecycle.js";
import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const PROJECT_SCOPE_ID = "10000000-0000-4000-8000-000000000301";
const CHAT_SCOPE_ID = "10000000-0000-4000-8000-000000000302";
const UNRELATED_SCOPE_ID = "10000000-0000-4000-8000-000000000303";
const OWNER_ID = "user_project_owner";
const SUCCESSOR_ID = "user_project_successor";
const VIEWER_ID = "user_project_viewer";
const SOURCE_RUNTIME = "vps:runtime_project_owner";
const DESTINATION_RUNTIME = "vps:runtime_project_successor";
const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("collaboration project lifecycle", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seed(fixture);
  });

  afterEach(async () => fixture.destroy());

  it("archives and restores the project and every inherited child atomically", async () => {
    const lifecycle = service(fixture);
    await expect(lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "archive",
      clientRequestId: request(1),
      expectedRevision: 4,
      payloadHash: "a".repeat(64),
    })).resolves.toMatchObject({ type: "archive", status: "completed", revision: "5" });
    await expect(scopeStates(fixture)).resolves.toEqual([
      { id: PROJECT_SCOPE_ID, lifecycle: "archived", revision: 5, auth_epoch: 4 },
      { id: CHAT_SCOPE_ID, lifecycle: "archived", revision: 3, auth_epoch: 4 },
    ]);

    await expect(lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "restore",
      clientRequestId: request(2),
      expectedRevision: 5,
      payloadHash: "b".repeat(64),
    })).resolves.toMatchObject({ type: "restore", status: "completed", revision: "6" });
    await expect(scopeStates(fixture)).resolves.toEqual([
      { id: PROJECT_SCOPE_ID, lifecycle: "shared", revision: 6, auth_epoch: 5 },
      { id: CHAT_SCOPE_ID, lifecycle: "shared", revision: 4, auth_epoch: 5 },
    ]);
  });

  it("transfers owner membership and the declared authority in one commit after staging", async () => {
    const stageTransfer = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      return {
        destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
        destinationAuthorityGeneration: 1,
        publicationMarker: "publication_owner_transfer",
      };
    });
    const lifecycle = service(fixture, { stageTransfer });

    await expect(lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "transfer",
      successorActorId: SUCCESSOR_ID,
      expectedMemberRevision: 1,
      clientRequestId: request(3),
      expectedRevision: 4,
      payloadHash: "c".repeat(64),
    })).resolves.toMatchObject({ type: "transfer", status: "completed", revision: "6" });
    expect(stageTransfer).toHaveBeenCalledTimes(1);

    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["owner_id", "authority_runtime_id", "authority_generation", "lifecycle"])
      .where("id", "in", [PROJECT_SCOPE_ID, CHAT_SCOPE_ID])
      .orderBy("id", "asc").execute()).resolves.toEqual([
      {
        owner_id: SUCCESSOR_ID,
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 1,
        lifecycle: "shared",
      },
      {
        owner_id: SUCCESSOR_ID,
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 1,
        lifecycle: "shared",
      },
    ]);
    await expect(fixture.db.selectFrom("collaboration_resource_bindings")
      .select(["authority_runtime_id", "authority_generation"])
      .where("project_scope_id", "=", PROJECT_SCOPE_ID).executeTakeFirstOrThrow()).resolves.toEqual({
      authority_runtime_id: DESTINATION_RUNTIME,
      authority_generation: 1,
    });
    await expect(fixture.db.selectFrom("collaboration_members")
      .select(["actor_id", "role", "status"])
      .where("scope_id", "=", PROJECT_SCOPE_ID)
      .orderBy("actor_id", "asc").execute()).resolves.toEqual([
      { actor_id: OWNER_ID, role: "editor", status: "accepted" },
      { actor_id: SUCCESSOR_ID, role: "owner", status: "accepted" },
      { actor_id: VIEWER_ID, role: "viewer", status: "accepted" },
    ]);
    await expect(fixture.db.selectFrom("collaboration_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("scope_id", "=", PROJECT_SCOPE_ID)
      .where("role", "=", "owner")
      .where("status", "=", "accepted")
      .executeTakeFirstOrThrow()).resolves.toEqual({ count: 1 });
  });

  it("recovers an interrupted transfer from the durable accepted operation", async () => {
    let fail = true;
    const stageTransfer = vi.fn(async () => {
      if (fail) throw new Error("simulated staging outage");
      return {
        destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
        destinationAuthorityGeneration: 1,
        publicationMarker: "publication_owner_transfer",
      };
    });
    const lifecycle = service(fixture, { stageTransfer });
    const accepted = await lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "transfer",
      successorActorId: SUCCESSOR_ID,
      expectedMemberRevision: 1,
      clientRequestId: request(4),
      expectedRevision: 4,
      payloadHash: "d".repeat(64),
    });
    expect(accepted).toMatchObject({ type: "transfer", status: "accepted", revision: "5" });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["owner_id", "lifecycle", "authority_runtime_id"])
      .where("id", "=", PROJECT_SCOPE_ID).executeTakeFirstOrThrow()).resolves.toEqual({
      owner_id: OWNER_ID,
      lifecycle: "recovering",
      authority_runtime_id: SOURCE_RUNTIME,
    });

    fail = false;
    await expect(lifecycle.recoverPending()).resolves.toEqual({ recovered: 1, failed: 0 });
    await expect(lifecycle.getOperation(PROJECT_SCOPE_ID, OWNER_ID, request(4)))
      .resolves.toMatchObject({ type: "transfer", status: "completed", revision: "6" });
  });

  it("keeps deletion fenced until cleanup succeeds and removes no unrelated scope", async () => {
    let fail = true;
    const deleteProject = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      if (fail) throw new Error("simulated cleanup outage");
    });
    const lifecycle = service(fixture, { deleteProject });
    const accepted = await lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "delete",
      clientRequestId: request(5),
      expectedRevision: 4,
      payloadHash: "e".repeat(64),
    });
    expect(accepted).toMatchObject({ type: "delete", status: "accepted", revision: "5" });
    await expect(fixture.db.selectFrom("collaboration_scopes").select("lifecycle")
      .where("id", "=", PROJECT_SCOPE_ID).executeTakeFirstOrThrow())
      .resolves.toEqual({ lifecycle: "deleting" });

    fail = false;
    await expect(lifecycle.recoverPending()).resolves.toEqual({ recovered: 1, failed: 0 });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "deleted_at"])
      .where("id", "in", [PROJECT_SCOPE_ID, CHAT_SCOPE_ID])
      .orderBy("id", "asc").execute()).resolves.toEqual([
      { lifecycle: "deleted", deleted_at: NOW },
      { lifecycle: "deleted", deleted_at: NOW },
    ]);
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "deleted_at"])
      .where("id", "=", UNRELATED_SCOPE_ID).executeTakeFirstOrThrow()).resolves.toEqual({
      lifecycle: "shared",
      deleted_at: null,
    });
    await expect(lifecycle.apply({
      scopeId: PROJECT_SCOPE_ID,
      actorId: OWNER_ID,
      type: "delete",
      clientRequestId: request(5),
      expectedRevision: 4,
      payloadHash: "e".repeat(64),
    })).resolves.toMatchObject({ type: "delete", status: "completed", revision: "6" });
    expect(deleteProject).toHaveBeenCalledTimes(2);
  });
});

function service(
  fixture: CollaborationTestDatabase,
  overrides: Partial<{
    stageTransfer: (input: {
      scopeId: string;
      projectId: string;
      operationId: string;
      successorActorId: string;
      sourceAuthorityRuntimeId: string;
      sourceAuthorityGeneration: number;
      signal: AbortSignal;
    }) => Promise<{
      destinationAuthorityRuntimeId: string;
      destinationAuthorityGeneration: number;
      publicationMarker: string;
    }>;
    deleteProject: (input: {
      scopeId: string;
      projectId: string;
      operationId: string;
      authorityRuntimeId: string;
      authorityGeneration: number;
      signal: AbortSignal;
    }) => Promise<void>;
  }> = {},
) {
  return createCollaborationProjectLifecycle({
    db: fixture.db,
    now: () => NOW,
    stageTransfer: overrides.stageTransfer ?? (async () => ({
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
      publicationMarker: "publication_owner_transfer",
    })),
    deleteProject: overrides.deleteProject ?? (async () => undefined),
  });
}

async function seed(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values([
    directProject(PROJECT_SCOPE_ID, "proj_alpha"),
    {
      ...directProject(CHAT_SCOPE_ID, "chat_alpha"),
      kind: "chat" as const,
      parent_scope_id: PROJECT_SCOPE_ID,
      membership_mode: "inherited" as const,
      revision: 2,
    },
    directProject(UNRELATED_SCOPE_ID, "proj_unrelated"),
  ]).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(PROJECT_SCOPE_ID, OWNER_ID, "owner"),
    member(PROJECT_SCOPE_ID, SUCCESSOR_ID, "editor"),
    member(PROJECT_SCOPE_ID, VIEWER_ID, "viewer"),
    member(UNRELATED_SCOPE_ID, OWNER_ID, "owner"),
  ]).execute();
  await fixture.db.insertInto("collaboration_resource_bindings").values({
    id: "30000000-0000-4000-8000-000000000301",
    project_scope_id: PROJECT_SCOPE_ID,
    resource_scope_id: CHAT_SCOPE_ID,
    resource_kind: "chat",
    resource_id: "chat_alpha",
    authority_runtime_id: SOURCE_RUNTIME,
    authority_generation: 3,
    revision: 2,
    readiness: "ready",
    blocker: null,
    incarnation: null,
    created_at: NOW,
    updated_at: NOW,
  }).execute();
}

function directProject(id: string, resourceId: string) {
  return {
    id,
    owner_type: "personal" as const,
    owner_id: OWNER_ID,
    kind: "project" as const,
    resource_id: resourceId,
    parent_scope_id: null,
    membership_mode: "direct" as const,
    lifecycle: "shared" as const,
    revision: 4,
    auth_epoch: 3,
    authority_runtime_id: SOURCE_RUNTIME,
    authority_generation: 3,
    execution_generation: null,
    execution_eligibility: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

function member(scopeId: string, actorId: string, role: "owner" | "editor" | "viewer") {
  return {
    scope_id: scopeId,
    actor_id: actorId,
    role,
    status: "accepted" as const,
    invitation_id: null,
    invited_by: OWNER_ID,
    accepted_at: NOW,
    expires_at: null,
    revision: 1,
    joined_at: NOW,
    updated_at: NOW,
  };
}

function request(value: number): string {
  return `40000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

async function scopeStates(fixture: CollaborationTestDatabase) {
  return fixture.db.selectFrom("collaboration_scopes")
    .select(["id", "lifecycle", "revision", "auth_epoch"])
    .where("id", "in", [PROJECT_SCOPE_ID, CHAT_SCOPE_ID])
    .orderBy("id", "asc")
    .execute();
}
