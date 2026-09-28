import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectSharingService } from "../../packages/gateway/src/collaboration/project-sharing.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const now = new Date("2026-09-28T12:00:00.000Z");
const projectId = "proj_alpha";
const projectScope = "10000000-0000-4000-8000-000000000701";
const chatScope = "10000000-0000-4000-8000-000000000702";
const directTerminalScope = "10000000-0000-4000-8000-000000000703";

function scope(id: string, kind: "project" | "chat" | "terminal", resourceId: string, parent: string | null = null) {
  return {
    id, owner_type: "personal" as const, owner_id: "user_owner", organization_id: "org_matrix",
    kind, resource_id: resourceId, parent_scope_id: parent,
    membership_mode: parent ? "inherited" as const : "direct" as const,
    lifecycle: "shared" as const, revision: 1, auth_epoch: 0,
    authority_runtime_id: "runtime_owner", authority_generation: 1,
    execution_generation: null, execution_eligibility: null,
    created_at: now, updated_at: now, deleted_at: null,
  };
}

function binding(id: string, kind: "chat" | "terminal" | "file" | "app", resourceId: string, childId: string | null) {
  return {
    id, project_scope_id: projectScope, resource_scope_id: childId,
    resource_kind: kind, resource_id: resourceId,
    authority_runtime_id: "runtime_owner", authority_generation: 1,
    revision: 1, readiness: "ready" as const, blocker: null,
    incarnation: kind === "terminal" ? "terminal-11111111111111111111111111111111" : null,
    created_at: now, updated_at: now,
  };
}

describe("shared project read children", () => {
  let fixture: CollaborationTestDatabase;
  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values([
      scope(projectScope, "project", projectId),
      scope(chatScope, "chat", "chat_alpha", projectScope),
      scope(directTerminalScope, "terminal", "terminal_private"),
    ]).execute();
    await fixture.db.insertInto("collaboration_resource_bindings").values([
      binding("30000000-0000-4000-8000-000000000701", "chat", "chat_alpha", chatScope),
      binding("30000000-0000-4000-8000-000000000702", "terminal", "terminal_private", directTerminalScope),
      binding("30000000-0000-4000-8000-000000000703", "file", "README.md", null),
      binding("30000000-0000-4000-8000-000000000704", "app", "app_board", null),
    ]).execute();
  });
  afterEach(async () => fixture.destroy());

  it("returns the owner-visible title and only inherited, live child scope IDs", async () => {
    const service = createProjectSharingService({
      db: fixture.db,
      inventory: { preview: async () => { throw new Error("unused"); }, verifyConfirmation: async () => undefined },
      transitions: {
        replayPreparation: async () => null,
        prepare: async () => { throw new Error("unused"); },
      },
      resolveDestination: async () => ({ runtimeId: "runtime_owner", authorityGeneration: 1 }),
      resolveProjectTitle: async () => "Team roadmap",
    });
    const result = await service.read({ scopeId: projectScope });
    expect(result.title).toBe("Team roadmap");
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "chat", id: "chat_alpha", scopeId: chatScope }),
      expect.objectContaining({ kind: "terminal", id: "terminal_private" }),
      expect.objectContaining({ kind: "file", id: "README.md" }),
      expect.objectContaining({ kind: "app", id: "app_board" }),
    ]));
    expect(result.resources.find((resource) => resource.kind === "terminal")).not.toHaveProperty("scopeId");
  });
});
