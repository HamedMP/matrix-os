import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectSharingService } from "../../packages/gateway/src/collaboration/project-sharing.js";
import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000701";
const CHAT_SCOPE = "10000000-0000-4000-8000-000000000702";
const OWNER = "user_owner";
const EDITOR = "user_editor";
const ITEM_ONLY = "user_item_only";

describe("whole-project sharing coordinator", () => {
  let fixture: CollaborationTestDatabase;
  let preview: ReturnType<typeof vi.fn>;
  let verifyConfirmation: ReturnType<typeof vi.fn>;
  let prepare: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seed(fixture);
    preview = vi.fn(async ({ membershipEffects }) => ({
      projectId: "proj_alpha",
      projectRevision: 7,
      ownedItems: [{ kind: "chat", id: "chat_alpha", revision: "2", compatibility: "ready" }],
      externalReferences: [],
      blockers: [],
      membershipEffects,
      inventoryHash: "a".repeat(64),
      membershipHash: "b".repeat(64),
      inventoryToken: "c".repeat(64),
      expiresAt: "2026-09-11T12:10:00.000Z",
    }));
    verifyConfirmation = vi.fn(async () => ({ projectRevision: 7 }));
    prepare = vi.fn(async () => ({
      id: "20000000-0000-4000-8000-000000000701",
      scopeId: PROJECT_SCOPE,
      status: "prepared",
      inventoryRevision: 7,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }));
  });

  afterEach(async () => fixture.destroy());

  it("derives project joins and exact child-grant endings without promoting item-only actors", async () => {
    const service = serviceFixture(fixture, preview, verifyConfirmation, prepare);
    const result = await service.preview({ scopeId: PROJECT_SCOPE, actorId: OWNER });
    expect(result.membershipEffects).toEqual([
      { actorId: EDITOR, role: "editor", effect: "join_project" },
      {
        actorId: EDITOR,
        role: "viewer",
        effect: "end_item_grant",
        resourceKind: "chat",
        resourceId: "chat_alpha",
      },
      {
        actorId: ITEM_ONLY,
        role: "viewer",
        effect: "end_item_grant",
        resourceKind: "chat",
        resourceId: "chat_alpha",
      },
    ]);
    expect(result.scopeRevision).toBe(4);
  });

  it("rebuilds and verifies the inventory before reserving one durable transition", async () => {
    const service = serviceFixture(fixture, preview, verifyConfirmation, prepare);
    await expect(service.confirm({
      scopeId: PROJECT_SCOPE,
      actorId: OWNER,
      clientRequestId: "50000000-0000-4000-8000-000000000701",
      payloadHash: "d".repeat(64),
      expectedScopeRevision: 4,
      expectedProjectRevision: 7,
      inventoryHash: "a".repeat(64),
      membershipHash: "b".repeat(64),
      inventoryToken: "c".repeat(64),
    })).resolves.toMatchObject({ status: "prepared" });
    expect(verifyConfirmation).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: PROJECT_SCOPE,
      ownerId: OWNER,
      clientRequestId: "50000000-0000-4000-8000-000000000701",
      payloadHash: "d".repeat(64),
      inventoryHash: "a".repeat(64),
      membershipHash: "b".repeat(64),
      destinationAuthorityRuntimeId: "runtime_project_shared",
      destinationAuthorityGeneration: 2,
    }));
  });

  it("rejects a changed inventory or any blocker before transition preparation", async () => {
    preview.mockResolvedValueOnce({
      ...(await preview({ membershipEffects: [] })),
      inventoryHash: "d".repeat(64),
    });
    const service = serviceFixture(fixture, preview, verifyConfirmation, prepare);
    await expect(service.confirm({
      scopeId: PROJECT_SCOPE,
      actorId: OWNER,
      clientRequestId: "50000000-0000-4000-8000-000000000702",
      payloadHash: "e".repeat(64),
      expectedScopeRevision: 4,
      expectedProjectRevision: 7,
      inventoryHash: "a".repeat(64),
      membershipHash: "b".repeat(64),
      inventoryToken: "c".repeat(64),
    })).rejects.toMatchObject({ code: "conflict" });
    expect(prepare).not.toHaveBeenCalled();
  });
});

function serviceFixture(
  fixture: CollaborationTestDatabase,
  preview: ReturnType<typeof vi.fn>,
  verifyConfirmation: ReturnType<typeof vi.fn>,
  prepare: ReturnType<typeof vi.fn>,
) {
  return createProjectSharingService({
    db: fixture.db,
    inventory: { preview, verifyConfirmation },
    transitions: { prepare },
    resolveDestination: async () => ({
      runtimeId: "runtime_project_shared",
      authorityGeneration: 2,
    }),
  });
}

async function seed(fixture: CollaborationTestDatabase) {
  await fixture.db.insertInto("collaboration_scopes").values([
    scope(PROJECT_SCOPE, "project", "proj_alpha", { revision: 4 }),
    scope(CHAT_SCOPE, "chat", "chat_alpha", { lifecycle: "shared", revision: 2 }),
  ]).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(PROJECT_SCOPE, OWNER, "owner"),
    member(PROJECT_SCOPE, EDITOR, "editor"),
    member(CHAT_SCOPE, OWNER, "owner"),
    member(CHAT_SCOPE, EDITOR, "viewer"),
    member(CHAT_SCOPE, ITEM_ONLY, "viewer"),
  ]).execute();
  await fixture.db.insertInto("collaboration_resource_bindings").values({
    id: "30000000-0000-4000-8000-000000000701",
    project_scope_id: PROJECT_SCOPE,
    resource_scope_id: CHAT_SCOPE,
    resource_kind: "chat",
    resource_id: "chat_alpha",
    authority_runtime_id: "runtime_project_shared",
    authority_generation: 2,
    revision: 1,
    readiness: "ready",
    blocker: null,
    incarnation: null,
    created_at: NOW,
    updated_at: NOW,
  }).execute();
}

function scope(id: string, kind: "project" | "chat", resourceId: string, overrides: {
  lifecycle?: "private" | "shared";
  revision: number;
}) {
  return {
    id,
    owner_type: "personal" as const,
    owner_id: OWNER,
    kind,
    resource_id: resourceId,
    parent_scope_id: null,
    membership_mode: "direct" as const,
    lifecycle: overrides.lifecycle ?? "private",
    revision: overrides.revision,
    auth_epoch: 0,
    authority_runtime_id: "runtime_project_owner",
    authority_generation: 1,
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
    invited_by: OWNER,
    accepted_at: NOW,
    expires_at: null,
    revision: 1,
    joined_at: NOW,
    updated_at: NOW,
  };
}
