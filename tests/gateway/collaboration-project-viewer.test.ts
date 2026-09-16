import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectResourceAdapterError,
  createProjectResourceAdapters,
} from "../../packages/gateway/src/collaboration/project-adapters.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const SCOPE_ID = "10000000-0000-4000-8000-000000000111";
const OWNER_ID = "user_project_owner";
const EDITOR_ID = "user_project_editor";
const VIEWER_ID = "user_project_viewer";
const PROJECT_ID = "proj_alpha";
const RUNTIME_ID = "runtime_project_shared";
const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("project collaboration resource authorization", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;
  let calls: Array<{ driver: string; input: unknown }>;
  let projectFence: { withAdmission: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: SCOPE_ID,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "project",
      resource_id: PROJECT_ID,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 5,
      auth_epoch: 1,
      authority_runtime_id: RUNTIME_ID,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    for (const [actorId, role] of [[OWNER_ID, "owner"], [EDITOR_ID, "editor"], [VIEWER_ID, "viewer"]] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: SCOPE_ID,
        actor_id: actorId,
        role,
        status: "accepted",
        invitation_id: null,
        invited_by: OWNER_ID,
        accepted_at: NOW,
        expires_at: null,
        revision: 1,
        joined_at: NOW,
        updated_at: NOW,
      }).execute();
    }
    for (const [id, resourceId] of [
      ["30000000-0000-4000-8000-000000000111", "README.md"],
      ["30000000-0000-4000-8000-000000000112", "src/index.ts"],
    ] as const) {
      await fixture.db.insertInto("collaboration_resource_bindings").values({
        id,
        project_scope_id: SCOPE_ID,
        resource_scope_id: null,
        resource_kind: "file",
        resource_id: resourceId,
        authority_runtime_id: RUNTIME_ID,
        authority_generation: 1,
        revision: 1,
        readiness: "ready",
        blocker: null,
        incarnation: null,
        created_at: NOW,
        updated_at: NOW,
      }).execute();
    }
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), { now: () => NOW });
    calls = [];
    projectFence = {
      withAdmission: vi.fn(async (_input, operation) => operation({ fenceEpoch: 1, authorityGeneration: 1 })),
    };
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function adapters(overrides: { listedPaths?: string[]; agentMode?: "scoped" | "unavailable" } = {}) {
    return createProjectResourceAdapters({
      db: fixture.db,
      authority,
      projectFence,
      files: {
        read: async (context, input) => {
          calls.push({ driver: "file.read", input: { context, input } });
          return { path: input.path, content: "shared" };
        },
        list: async (context, input) => {
          calls.push({ driver: "file.list", input: { context, input } });
          return (overrides.listedPaths ?? ["README.md", "src/index.ts"]).map((path) => ({ path }));
        },
        search: async (context, input) => {
          calls.push({ driver: "file.search", input: { context, input } });
          return [{ path: "src/index.ts", line: 1, preview: "shared" }];
        },
        write: async (context, input) => {
          calls.push({ driver: "file.write", input: { context, input } });
          return { revision: input.expectedRevision + 1 };
        },
        delete: async (context, input) => {
          calls.push({ driver: "file.delete", input: { context, input } });
          return { deleted: true };
        },
      },
      git: {
        inspect: async (context, input) => {
          calls.push({ driver: "git.inspect", input: { context, input } });
          return { clean: true };
        },
        mutate: async (context, input) => {
          calls.push({ driver: "git.mutate", input: { context, input } });
          return { ok: true };
        },
      },
      agents: {
        collaborationMode: overrides.agentMode ?? "scoped",
        inspect: async (context, input) => {
          calls.push({ driver: "agent.inspect", input: { context, input } });
          return { status: "idle" };
        },
        start: async (context, input) => {
          calls.push({ driver: "agent.start", input: { context, input } });
          return { operationId: "operation_1" };
        },
      },
      apps: {
        query: async (_context, input) => ({ appId: input.appId, readable: true }),
        mutate: async (_context, input) => ({ appId: (input as { appId: string }).appId, revision: 2 }),
      },
      layout: {
        get: async () => ({ layout: { nodes: [] }, viewState: null }),
        patchNode: async () => ({ nodeRevision: 1 }),
        putViewState: async () => ({ revision: 1 }),
      },
      exports: {
        create: async (context, input) => {
          calls.push({ driver: "export.create", input: { context, input } });
          return { exportId: "export_1" };
        },
      },
    });
  }

  async function context(actorId: string) {
    return authority.authorize({ scopeId: SCOPE_ID, actorId, action: "read" });
  }

  it("allows viewers to read only bound files, Git state, app data, layout, and agent status", async () => {
    const resources = adapters();
    const viewer = await context(VIEWER_ID);
    await expect(resources.readFile(viewer, { path: "README.md" })).resolves.toMatchObject({ content: "shared" });
    await expect(resources.listFiles(viewer, { limit: 20 })).resolves.toHaveLength(2);
    await expect(resources.searchFiles(viewer, { query: "shared", limit: 20 })).resolves.toHaveLength(1);
    await expect(resources.inspectGit(viewer, { kind: "status" })).resolves.toEqual({ clean: true });
    await expect(resources.inspectAgent(viewer, { agentId: "agent_1" })).resolves.toEqual({ status: "idle" });
    await expect(resources.queryApp(viewer, { appId: "app_board", action: { action: "find" } }))
      .resolves.toMatchObject({ readable: true });
    await expect(resources.getLayout(viewer, { canvasId: "cnv_project_alpha_12345678" }))
      .resolves.toMatchObject({ viewState: null });
  });

  it("denies every indirect shared mutation to viewers before a driver or fence runs", async () => {
    const resources = adapters();
    const viewer = await context(VIEWER_ID);
    const attempts = [
      () => resources.writeFile(viewer, { path: "README.md", content: "denied", expectedRevision: 1, clientRequestId: "50000000-0000-4000-8000-000000000111" }),
      () => resources.deleteFile(viewer, { path: "README.md", expectedRevision: 1, clientRequestId: "50000000-0000-4000-8000-000000000112" }),
      () => resources.mutateGit(viewer, { action: "stage", paths: ["README.md"], clientRequestId: "50000000-0000-4000-8000-000000000113" }),
      () => resources.startAgent(viewer, { agentId: "agent_1", prompt: "work", clientRequestId: "50000000-0000-4000-8000-000000000114" }),
      () => resources.mutateApp(viewer, { appId: "app_board", clientRequestId: "50000000-0000-4000-8000-000000000115" }),
      () => resources.patchLayout(viewer, { canvasId: "cnv_project_alpha_12345678", nodeId: "node_app", clientRequestId: "50000000-0000-4000-8000-000000000116" }),
      () => resources.createExport(viewer, { clientRequestId: "50000000-0000-4000-8000-000000000117" }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(calls.filter((call) => ["file.write", "file.delete", "git.mutate", "agent.start", "export.create"].includes(call.driver))).toEqual([]);
    expect(projectFence.withAdmission).not.toHaveBeenCalled();
  });

  it("routes editor writes and runs through the scoped authority fence", async () => {
    const resources = adapters();
    const editor = await context(EDITOR_ID);
    await resources.writeFile(editor, { path: "README.md", content: "updated", expectedRevision: 1, clientRequestId: "50000000-0000-4000-8000-000000000121" });
    await resources.mutateGit(editor, { action: "commit", message: "feat: update", clientRequestId: "50000000-0000-4000-8000-000000000122" });
    await resources.startAgent(editor, { agentId: "agent_1", prompt: "work", clientRequestId: "50000000-0000-4000-8000-000000000123" });

    expect(projectFence.withAdmission).toHaveBeenCalledTimes(3);
    expect(projectFence.withAdmission).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "write", path: "scoped", projectId: PROJECT_ID }), expect.any(Function));
    expect(projectFence.withAdmission).toHaveBeenNthCalledWith(3, expect.objectContaining({ kind: "run", path: "scoped", projectId: PROJECT_ID }), expect.any(Function));

    await expect(adapters({ agentMode: "unavailable" }).startAgent(editor, {
      agentId: "agent_1",
      prompt: "work",
      clientRequestId: "50000000-0000-4000-8000-000000000124",
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fails closed for stale links, traversal, and unbound search results", async () => {
    const viewer = await context(VIEWER_ID);
    await expect(adapters().readFile(viewer, { path: "../private.txt" }))
      .rejects.toMatchObject({ code: "invalid" });
    await expect(adapters().readFile(viewer, { path: "missing.txt" }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(adapters({ listedPaths: ["README.md", "../private.txt"] }).listFiles(viewer, { limit: 20 }))
      .rejects.toMatchObject({ code: "unavailable" });

    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 2, auth_epoch: 2 })
      .where("id", "=", SCOPE_ID).execute();
    await expect(adapters().inspectGit(viewer, { kind: "status" }))
      .rejects.toBeInstanceOf(ProjectResourceAdapterError);
  });

  it("keeps exports owner-only and strips owner credentials from driver contexts", async () => {
    const resources = adapters();
    await expect(resources.createExport(await context(EDITOR_ID), {
      clientRequestId: "50000000-0000-4000-8000-000000000131",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(resources.createExport(await context(OWNER_ID), {
      clientRequestId: "50000000-0000-4000-8000-000000000132",
    })).resolves.toEqual({ exportId: "export_1" });
    expect(JSON.stringify(calls)).not.toMatch(/credential|secret|homePath|\/home\//i);
  });
});
