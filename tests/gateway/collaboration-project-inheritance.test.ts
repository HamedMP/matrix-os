import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectInheritanceError,
  createProjectInheritanceResolver,
} from "../../packages/gateway/src/collaboration/project-inheritance.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE_ID = "10000000-0000-4000-8000-000000000071";
const OWNER_ID = "user_project_owner";
const AUTHORITY_RUNTIME_ID = "runtime_project_shared";
const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("project collaboration inheritance", () => {
  let fixture: CollaborationTestDatabase;
  let sequence: number;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: PROJECT_SCOPE_ID,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "project",
      resource_id: "proj_alpha",
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "preparing",
      revision: 4,
      auth_epoch: 0,
      authority_runtime_id: AUTHORITY_RUNTIME_ID,
      authority_generation: 2,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    sequence = 80;
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function resolver() {
    return createProjectInheritanceResolver({
      db: fixture.db,
      now: () => NOW,
      createBindingId: () => `30000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      createScopeId: () => `40000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    });
  }

  it("atomically binds every existing owned resource kind to one project authority", async () => {
    const inheritance = resolver();
    const inputs = [
      { kind: "file" as const, resourceId: "src/index.ts" },
      { kind: "chat" as const, resourceId: "chat_project" },
      { kind: "app" as const, resourceId: "app_board" },
      { kind: "layout" as const, resourceId: "layout" },
      {
        kind: "terminal" as const,
        resourceId: "terminal_project",
        incarnation: "terminal_11111111111111111111111111111111",
      },
    ];

    const bindings = [];
    for (const input of inputs) {
      bindings.push(await inheritance.bindOwnedResource({
        projectScopeId: PROJECT_SCOPE_ID,
        ownerId: OWNER_ID,
        authorityRuntimeId: AUTHORITY_RUNTIME_ID,
        authorityGeneration: 2,
        revision: 1,
        readiness: "ready",
        ...input,
      }));
    }

    expect(bindings.map((binding) => binding.kind)).toEqual(["file", "chat", "app", "layout", "terminal"]);
    expect(bindings.every((binding) => binding.membershipScopeId === PROJECT_SCOPE_ID)).toBe(true);
    expect(bindings.filter((binding) => binding.kind === "chat" || binding.kind === "terminal")
      .every((binding) => binding.resourceScopeId !== undefined)).toBe(true);
    expect(await fixture.db.selectFrom("collaboration_members").selectAll().execute()).toEqual([]);
  });

  it("uses one idempotent binding for concurrent future-content creation", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" })
      .where("id", "=", PROJECT_SCOPE_ID).execute();
    const inheritance = resolver();
    const input = {
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "chat" as const,
      resourceId: "chat_future",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 1,
      readiness: "ready" as const,
    };

    const [first, replay] = await Promise.all([
      inheritance.bindOwnedResource(input),
      inheritance.bindOwnedResource(input),
    ]);
    expect(replay).toEqual(first);
    expect(await fixture.db.selectFrom("collaboration_resource_bindings")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("project_scope_id", "=", PROJECT_SCOPE_ID)
      .where("resource_kind", "=", "chat")
      .where("resource_id", "=", "chat_future").executeTakeFirstOrThrow()).toEqual({ count: 1 });
  });

  it("does not silently convert or promote an existing direct item-only scope", async () => {
    const directScopeId = "10000000-0000-4000-8000-000000000072";
    await fixture.db.insertInto("collaboration_scopes").values({
      id: directScopeId,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "chat",
      resource_id: "chat_direct",
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 2,
      auth_epoch: 2,
      authority_runtime_id: "runtime_item_only",
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: directScopeId,
      actor_id: "user_item_only",
      role: "viewer",
      status: "accepted",
      invitation_id: null,
      invited_by: OWNER_ID,
      accepted_at: NOW,
      expires_at: null,
      revision: 1,
      joined_at: NOW,
      updated_at: NOW,
    }).execute();

    await expect(resolver().bindOwnedResource({
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "chat",
      resourceId: "chat_direct",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 2,
      readiness: "ready",
    })).rejects.toBeInstanceOf(ProjectInheritanceError);
    await expect(fixture.db.selectFrom("collaboration_members").selectAll()
      .where("scope_id", "=", directScopeId).execute()).resolves.toHaveLength(1);
  });

  it("resolves inherited membership through the project without broadening sibling identity", async () => {
    const inheritance = resolver();
    const binding = await inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "app",
      resourceId: "app_board",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 3,
      readiness: "ready",
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" })
      .where("id", "=", PROJECT_SCOPE_ID).execute();

    await expect(inheritance.resolve({
      ownerId: OWNER_ID,
      kind: "app",
      resourceId: "app_board",
    })).resolves.toEqual(binding);
    await expect(inheritance.resolve({
      ownerId: OWNER_ID,
      kind: "app",
      resourceId: "app_sibling",
    })).resolves.toBeNull();
  });

  it("requires terminal incarnation and blocks activation while any owned binding is unavailable", async () => {
    const inheritance = resolver();
    await expect(inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "file",
      resourceId: "../private.txt",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 1,
      readiness: "ready",
    })).rejects.toMatchObject({ code: "invalid_resource" });
    await expect(inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "terminal",
      resourceId: "terminal_missing_incarnation",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 1,
      readiness: "ready",
    })).rejects.toMatchObject({ code: "invalid_resource" });
    await inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "app",
      resourceId: "app_unsafe",
      authorityRuntimeId: AUTHORITY_RUNTIME_ID,
      authorityGeneration: 2,
      revision: 1,
      readiness: "blocked",
      blocker: "role_enforcement_unavailable",
    });

    await expect(inheritance.assertReadyForActivation(PROJECT_SCOPE_ID))
      .rejects.toMatchObject({ code: "resource_blocked" });
  });
});
