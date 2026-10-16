import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import { createProjectLifecycleService } from "../../packages/gateway/src/project-lifecycle.js";
import { createProjectManager, type ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { registerWorkspaceLifecycle } from "../../packages/gateway/src/server/workspace-lifecycle.js";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority-error.js";
import { allowAllOrganizationPrecondition, createCollaborationTestDatabase } from "./collaboration-test-support.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

const OWNER = "user_shared_delete";
const SCOPE = "10000000-0000-4000-8000-000000000901";
const CHILD = "10000000-0000-4000-8000-000000000902";
const RUNTIME = "vps:shared_delete";
const startup = vi.hoisted(() => ({ run: vi.fn(async () => ({ status: "ok", steps: [] })) }));
vi.mock("../../packages/gateway/src/workspace-startup-recovery.js", () => ({
  createWorkspaceStartupRecovery: () => ({ run: startup.run, close: vi.fn() }),
}));

describe("owner shared-project deletion through workspace HTTP", () => {
  let homePath: string;
  let fixture: Awaited<ReturnType<typeof createCollaborationTestDatabase>>;
  let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>>;
  let projects: ReturnType<typeof createProjectManager>;
  let project: ProjectConfig;
  const cleanup = vi.fn(async () => undefined);

  beforeEach(async () => {
    cleanup.mockReset().mockResolvedValue(undefined);
    homePath = await mkdtemp(join(tmpdir(), "shared-project-deletion-"));
    fixture = await createCollaborationTestDatabase();
    const chats = new ChatRepository(fixture.db);
    await chats.bootstrap();
    runtime = await createGatewayCollaboration({
      db: fixture.db, chatRepository: chats, startTimers: false,
      organizationPrecondition: allowAllOrganizationPrecondition,
      config: { runtimeId: RUNTIME, ownerId: OWNER, platformBaseUrl: "https://platform.invalid", serviceToken: "s".repeat(32) },
    });
    projects = createProjectManager({ homePath });
    const created = await projects.createProject({ mode: "scratch", name: "Shared repo", slug: "shared-repo", ownerScope: { type: "user", id: OWNER } });
    if (!created.ok) throw new Error("Project fixture unavailable");
    project = created.project;
    const now = new Date();
    const scope = { id: SCOPE, owner_type: "personal" as const, owner_id: OWNER,
      organization_id: "org_shared_delete", kind: "project" as const, resource_id: project.id,
      parent_scope_id: null, membership_mode: "direct" as const, lifecycle: "shared" as const,
      revision: 4, auth_epoch: 3, authority_runtime_id: RUNTIME, authority_generation: 3,
      execution_generation: null, execution_eligibility: null, created_at: now, updated_at: now, deleted_at: null };
    await fixture.db.insertInto("collaboration_scopes").values([
      scope, { ...scope, id: CHILD, kind: "chat", resource_id: "chat_delete_child", parent_scope_id: SCOPE, membership_mode: "inherited" },
    ]).execute();
    await fixture.db.insertInto("collaboration_members").values({ scope_id: SCOPE,
      organization_id: "org_shared_delete", actor_id: OWNER, role: "owner", status: "accepted",
      invitation_id: null, invited_by: OWNER, accepted_at: now, expires_at: null,
      revision: 1, joined_at: now, updated_at: now }).execute();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    startup.run.mockClear();
    await runtime.shutdown();
    await fixture.destroy();
    await rm(homePath, { recursive: true, force: true });
  });

  function app(owner = OWNER) {
    const localLifecycle = createProjectLifecycleService({ projectManager: projects,
      findBlockers: async () => [], cleanupRelatedState: cleanup });
    return createWorkspaceRoutes({ homePath, projectManager: projects,
      projectLifecycleService: localLifecycle,
      projectOperationAdmission: runtime.projectOperationAdmission,
      configureSharedProjectDeletion: runtime.enableProjectDeletion,
      terminalRuntime: { listWorkspaces: async () => [] } as never,
      getOwnerScope: () => ({ type: "user", id: owner }),
    });
  }

  async function remove(target = app(), confirmation = project.name, method = "POST") {
    return target.request(`/api/projects/${project.slug}${method === "POST" ? "/actions" : ""}`, {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(method === "POST" ? { type: "delete" } : {}), confirmation, confirmTerminate: true }),
    });
  }

  it.each(["POST", "DELETE"])("%s deletes the owned shared project and retires inherited scopes", async (method) => {
    const target = app();
    const response = await remove(target, project.name, method);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, action: "delete", projectSlug: project.slug });
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await projects.listManagedProjects()).projects).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").execute())
      .toEqual([{ lifecycle: "deleted" }, { lifecycle: "deleted" }]);
    const operations = await fixture.db.selectFrom("collaboration_operations").select(["operation_kind", "status"]).execute();
    expect(operations).toEqual([{ operation_kind: "project.delete", status: "completed" }]);
  });

  it("keeps failed cleanup fenced and retries the same operation despite the local tombstone", async () => {
    cleanup.mockRejectedValueOnce(new Error("simulated cleanup outage"));
    const target = app();
    const failed = await remove(target);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: "delete_incomplete" } });
    expect((await projects.getProjectForLifecycle({ slug: project.slug, ownerScope: project.ownerScope })).ok).toBe(true);
    expect((await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("id", "=", SCOPE).executeTakeFirst())?.lifecycle).toBe("deleting");
    expect((await remove(target)).status).toBe(200);
    expect(await fixture.db.selectFrom("collaboration_operations").select("status").execute()).toEqual([{ status: "completed" }]);
  });

  it("does not mistake a project moving into deletion for completed cleanup", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const live = projects.listManagedProjects.bind(projects);
    const deleting = projects.listDeletingProjects.bind(projects);
    let marked = false;
    vi.spyOn(projects, "listManagedProjects").mockImplementationOnce(async input => {
      entered();
      await gate;
      return live(input);
    });
    vi.spyOn(projects, "listDeletingProjects").mockImplementation(async () => marked
      ? deleting() : { projects: [], nextCursor: null });
    cleanup.mockRejectedValueOnce(new Error("cleanup has not completed"));
    const request = remove(app());
    await started;
    await projects.setProjectLifecycleState({ slug: project.slug, ownerScope: project.ownerScope, deletingAt: new Date().toISOString() });
    marked = true;
    resume();
    expect((await request).status).toBe(503);
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await fixture.db.selectFrom("collaboration_operations").select("status").executeTakeFirst())?.status).toBe("accepted");
  });

  it("recovers accepted deletion after startup dependencies have been bound", async () => {
    cleanup.mockRejectedValueOnce(new Error("simulated outage"));
    await remove(app());
    await expect(runtime.recoverProjectDeletions()).resolves.toEqual({ recovered: 1, failed: 0 });
    expect((await projects.listDeletingProjects()).projects).toEqual([]);
    expect((await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("id", "=", SCOPE).executeTakeFirst())?.lifecycle).toBe("deleted");
  });

  it("does not let ordinary tombstone recovery bypass the shared deletion journal", async () => {
    cleanup.mockRejectedValueOnce(new Error("simulated outage"));
    expect((await remove(app())).status).toBe(503);
    cleanup.mockClear();
    const localRecovery = createProjectLifecycleService({ projectManager: projects,
      findBlockers: async () => [], cleanupRelatedState: cleanup,
      canRecoverDeletion: runtime.canRecoverProjectDeletion,
    });
    await expect(localRecovery.recoverDeletingProjects()).resolves.toEqual({ recovered: 0, failed: 1 });
    expect(cleanup).not.toHaveBeenCalled();
    expect((await projects.listDeletingProjects()).projects).toHaveLength(1);
  });

  it("rejects another owner and a mismatched confirmation before reserving deletion", async () => {
    expect((await remove(app("user_other"))).status).toBe(404);
    expect((await remove(app(), "wrong name")).status).toBe(400);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await fixture.db.selectFrom("collaboration_operations").selectAll().execute()).toEqual([]);
  });

  it("fails closed when the shared project's runtime authority changed", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ authority_runtime_id: "vps:elsewhere" }).where("id", "=", SCOPE).execute();
    expect((await remove()).status).toBe(409);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("requires both accepted ownership and current organization membership", async () => {
    const target = app();
    await fixture.db.updateTable("collaboration_members").set({ role: "editor" }).where("scope_id", "=", SCOPE).execute();
    expect((await remove(target)).status).toBe(403);
    await fixture.db.updateTable("collaboration_members").set({ role: "owner" }).where("scope_id", "=", SCOPE).execute();
    vi.spyOn(runtime.organizationPrecondition, "require").mockRejectedValue(new CollaborationAuthorizationError("forbidden", "No membership"));
    expect((await remove(target)).status).toBe(403);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await fixture.db.selectFrom("collaboration_operations").selectAll().execute()).toEqual([]);
  });

  it("completes the journal after local cleanup finished before a lost response", async () => {
    const removeManagedProject = projects.removeManagedProject.bind(projects);
    vi.spyOn(projects, "removeManagedProject").mockImplementationOnce(async input => {
      await removeManagedProject(input);
      throw new Error("simulated crash after registry removal");
    });
    expect((await remove()).status).toBe(503);
    expect((await projects.listDeletingProjects()).projects).toEqual([]);
    await expect(runtime.recoverProjectDeletions()).resolves.toEqual({ recovered: 1, failed: 0 });
    expect((await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("id", "=", SCOPE).executeTakeFirst())?.lifecycle).toBe("deleted");
  });

  it("binds real Chat and terminal cleanup before production journal recovery", async () => {
    const chats = new ChatRepository(fixture.db);
    await chats.create({ type: "personal", ownerId: OWNER }, { id: "chat_delete_child", projectId: project.id,
      title: "Shared history", clientRequestId: "req_delete_fixture_chat" });
    const active = createCanonicalChatFixture("accepted").snapshot;
    await chats.admitTurn({ type: "personal", ownerId: OWNER }, { chatId: "chat_delete_child", baseRevision: 0,
      message: { ...active.messages[0]!, chatId: "chat_delete_child" },
      turn: { ...active.turns[0]!, chatId: "chat_delete_child" },
      run: { ...active.runs[0]!, chatId: "chat_delete_child", executionRoot: { kind: "project", projectId: project.id } },
    });
    await fixture.db.updateTable("chats").set({ collaboration: { scopeId: CHILD, mode: "discussion_only",
      executionFenced: true, authorityGeneration: 3 } }).where("id", "=", "chat_delete_child").execute();
    cleanup.mockRejectedValueOnce(new Error("simulated interruption"));
    expect((await remove(app())).status).toBe(503);
    const deleteWorkspace = vi.fn(async () => undefined);
    const deleteProjectThreads = vi.fn(async () => ({ ok: true as const, deleted: 0 }));
    const cancelRun = vi.fn().mockRejectedValue(new Error("Personal cancellation must remain fenced"));
    const cancelSharedRun = vi.fn(async (owner: Parameters<ChatRepository["finishRun"]>[0], scopeId: string, chatId: string, runId: string) => {
      expect(scopeId).toBe(CHILD);
      await chats.finishRun(owner, { chatId, runId, outcome: "aborted", completedAt: new Date().toISOString() });
    });
    startup.run.mockImplementationOnce(async () => {
      expect(await chats.list({ type: "personal", ownerId: OWNER }, { projectId: project.id, limit: 100 }))
        .toMatchObject({ items: [] });
      expect(deleteWorkspace).toHaveBeenCalledOnce();
      return { status: "ok", steps: [] };
    });
    await registerWorkspaceLifecycle({ app: new Hono(), shellRoutes: new Hono(), chatRepository: chats,
      orchestrator: { cancelRun, cancelSharedRun } as never, collaboration: runtime,
      workspace: { homePath, projectManager: projects, projectOperationAdmission: runtime.projectOperationAdmission,
        terminalRuntime: { listWorkspaces: async () => [{ id: "workspace", scope: "project", projectId: project.id, tabs: [] }], deleteWorkspace } as never,
        codingAgentThreadStore: { deleteProjectThreads } as never,
        agentSessionManager: { deleteProjectSessions: async ({ beforeRemove }: { beforeRemove: (sessions: never[]) => Promise<void> }) => { await beforeRemove([]); return { ok: true, deleted: 0 }; } } as never,
        reviewStore: { deleteProjectReviews: async () => ({ ok: true, deleted: 0 }) } as never,
      }, recovery: { homePath },
    });
    expect(startup.run).toHaveBeenCalledOnce();
    expect(deleteProjectThreads).toHaveBeenCalledOnce();
    expect(cancelSharedRun).toHaveBeenCalledOnce();
    expect(cancelRun).not.toHaveBeenCalled();
    expect((await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("id", "=", SCOPE).executeTakeFirst())?.lifecycle).toBe("deleted");
  });

  it("preserves external folder files and unrelated projects", async () => {
    const external = join(homePath, "external");
    await mkdir(external);
    try {
      await writeFile(join(external, "keep.txt"), "owner data");
      const folder = await projects.createProject({ mode: "folder", path: "external", name: "External", slug: "external", ownerScope: project.ownerScope });
      if (!folder.ok) throw new Error("Folder fixture unavailable");
      await fixture.db.updateTable("collaboration_scopes").set({ resource_id: folder.project.id }).where("id", "=", SCOPE).execute();
      const unrelated = project;
      project = folder.project;
      expect((await remove()).status).toBe(200);
      expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("owner data");
      expect((await projects.getProject(unrelated.slug, unrelated.ownerScope)).ok).toBe(true);
    } finally { await rm(external, { recursive: true, force: true }); }
  });
});
