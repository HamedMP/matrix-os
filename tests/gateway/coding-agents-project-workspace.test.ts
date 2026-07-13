import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentRuntimeSummaryService } from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import {
  CodingAgentProjectWorkspaceError,
  createCodingAgentProjectWorkspaceStore,
  createOwnerCodingAgentProjectWorkspaceStore,
} from "../../packages/gateway/src/coding-agents/project-workspace.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = "2026-07-10T10:00:00.000Z";

function emptyWorkspace() {
  return {
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 0,
      threadCount: 0,
      attentionCount: 0,
    },
    tasks: { items: [], hasMore: false, limit: 50 },
    projectThreads: { items: [], hasMore: false, limit: 50 },
    taskThreads: { items: [], hasMore: false, limit: 50 },
    updatedAt: now,
  };
}

describe("coding agent project workspace route", () => {
  it("GW-004 advertises the project workspace only when its read model is available", async () => {
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      projects: {
        listProjectSummaries: vi.fn(async () => ({ items: [], hasMore: false, limit: 50 })),
      },
      capabilities: { projectWorkspace: true },
      now: () => new Date(now),
    });

    const summary = await service.getSummary(testPrincipal);

    expect(summary.capabilities).toContainEqual({
      id: "codingAgentsProjectWorkspace",
      enabled: true,
    });
  });

  it("GW-004 authenticates before reading a project workspace", async () => {
    const getProjectWorkspace = vi.fn();
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      projectWorkspaces: { getProjectWorkspace },
      getPrincipal: () => {
        throw new MissingRequestPrincipalError();
      },
    }));

    const response = await app.request("/api/coding-agents/projects/matrix-os/workspace");

    expect(response.status).toBe(401);
    expect(getProjectWorkspace).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("GW-005 validates project workspace path, cursors, limits, and unknown queries", async () => {
    const getProjectWorkspace = vi.fn(async () => emptyWorkspace());
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      projectWorkspaces: { getProjectWorkspace },
      getPrincipal: () => testPrincipal,
    }));

    const valid = await app.request(
      "/api/coding-agents/projects/matrix-os/workspace" +
      "?taskCursor=task_auth&taskLimit=25" +
      "&projectThreadCursor=thread_audit&projectThreadLimit=10" +
      "&taskThreadCursor=thread_fix&taskThreadLimit=30",
    );

    expect(valid.status).toBe(200);
    expect(getProjectWorkspace).toHaveBeenCalledWith(testPrincipal, "matrix-os", {
      taskCursor: "task_auth",
      taskLimit: 25,
      projectThreadCursor: "thread_audit",
      projectThreadLimit: 10,
      taskThreadCursor: "thread_fix",
      taskThreadLimit: 30,
    });

    for (const path of [
      "/api/coding-agents/projects/bad:project/workspace",
      "/api/coding-agents/projects/matrix-os/workspace?taskLimit=0",
      "/api/coding-agents/projects/matrix-os/workspace?projectThreadLimit=101",
      "/api/coding-agents/projects/matrix-os/workspace?taskThreadLimit=many",
      "/api/coding-agents/projects/matrix-os/workspace?taskCursor=task_",
      "/api/coding-agents/projects/matrix-os/workspace?projectThreadCursor=evt_wrong",
      "/api/coding-agents/projects/matrix-os/workspace?taskLimit=25&taskLimit=30",
      "/api/coding-agents/projects/matrix-os/workspace?unexpected=value",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "validation_failed",
          safeMessage: "Request could not be processed. Check the inputs and try again.",
          retryable: false,
        },
      });
    }
    expect(getProjectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("GW-004 maps missing and failed workspaces to safe errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const [error, status, code] of [
        [new CodingAgentProjectWorkspaceError("project_not_found"), 404, "project_not_found"],
        [new Error("Postgres failed at /home/matrix/private token=secret"), 503, "project_workspace_unavailable"],
      ] as const) {
        const app = new Hono();
        app.route("/api/coding-agents", createCodingAgentRoutes({
          service: { getSummary: vi.fn() },
          projectWorkspaces: { getProjectWorkspace: vi.fn(async () => { throw error; }) },
          getPrincipal: () => testPrincipal,
        }));

        const response = await app.request("/api/coding-agents/projects/matrix-os/workspace");
        const body = await response.json() as { error: { code: string } };

        expect(response.status).toBe(status);
        expect(body.error.code).toBe(code);
        expect(JSON.stringify(body)).not.toMatch(/Postgres|\/home\/matrix|secret/i);
      }
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Postgres|\/home\/matrix|secret/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("GW-006 GW-007 projects multiple task chats separately from project chats", async () => {
    const projectWorkspaces = createCodingAgentProjectWorkspaceStore({
      projectManager: {
        getProject: vi.fn(async () => ({
          ok: true as const,
          project: {
            slug: "matrix-os",
            name: "Matrix OS",
            updatedAt: now,
          },
        })),
      },
      taskManager: {
        listTasks: vi.fn(async () => ({
          ok: true as const,
          tasks: [{
            id: "task_auth",
            projectSlug: "matrix-os",
            title: "Harden authentication",
            status: "running" as const,
            priority: "high" as const,
            order: 1,
            createdAt: now,
            updatedAt: now,
          }],
          nextCursor: null,
        })),
      },
      threads: {
        getProjectWorkspaceThreads: vi.fn(async () => ({
          projectThreads: {
            items: [threadSummary("thread_audit", undefined, "completed")],
            hasMore: false,
            limit: 50,
          },
          taskThreads: {
            items: [
              threadSummary("thread_plan", "task_auth", "completed"),
              threadSummary("thread_fix", "task_auth", "running", "failed"),
            ],
            hasMore: false,
            limit: 50,
          },
          taskAggregates: [{
            taskId: "task_auth",
            threadCount: 2,
            activeThreadCount: 1,
            attentionCount: 1,
            latestThreadAt: now,
          }],
          threadCount: 3,
          attentionCount: 1,
        })),
      },
      principalOwnerIds: [testPrincipal.userId],
      now: () => new Date(now),
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: { getSummary: vi.fn() },
      projectWorkspaces,
      getPrincipal: () => testPrincipal,
    }));

    const response = await app.request("/api/coding-agents/projects/matrix-os/workspace");
    const workspace = await response.json() as ReturnType<typeof emptyWorkspace>;

    expect(response.status).toBe(200);
    expect(workspace.tasks.items).toEqual([
      expect.objectContaining({
        id: "task_auth",
        threadCount: 2,
        activeThreadCount: 1,
        attentionCount: 1,
      }),
    ]);
    expect(workspace.projectThreads.items.map((thread) => thread.id)).toEqual(["thread_audit"]);
    expect(workspace.taskThreads.items.map((thread) => thread.id)).toEqual(["thread_plan", "thread_fix"]);
    expect(workspace.projectThreads.items.every((thread) => thread.taskId === undefined)).toBe(true);
    expect(workspace.taskThreads.items.every((thread) => thread.taskId === "task_auth")).toBe(true);
  });

  it("GW-006 wires the owner project, task, and thread services", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-agent-project-workspace-owner-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      providers: [{ providerId: "codex", startThread: () => [] }],
      now: () => new Date(now),
    });
    try {
      const projectManager = createProjectManager({ homePath, now: () => now });
      const taskManager = createTaskManager({ homePath, now: () => now });
      await projectManager.createProject({
        mode: "scratch",
        slug: "matrix-os",
        name: "Matrix OS",
        ownerScope: { type: "user", id: testPrincipal.userId },
      });
      await projectManager.createProject({
        mode: "scratch",
        slug: "website",
        name: "Website",
        ownerScope: { type: "user", id: testPrincipal.userId },
      });
      const taskResult = await taskManager.createTask("matrix-os", {
        title: "Harden authentication",
        status: "running",
        priority: "high",
      });
      if (!taskResult.ok) throw new Error("task fixture failed");
      const otherTaskResult = await taskManager.createTask("website", {
        title: "Publish docs",
        status: "running",
        priority: "normal",
      });
      if (!otherTaskResult.ok) throw new Error("other task fixture failed");
      await threads.createThread(testPrincipal, {
        providerId: "codex",
        prompt: "Plan authentication",
        projectId: "matrix-os",
        taskId: taskResult.task.id,
        clientRequestId: "req_owner_plan",
      });
      await threads.createThread(testPrincipal, {
        providerId: "codex",
        prompt: "Audit project",
        projectId: "matrix-os",
        clientRequestId: "req_owner_audit",
      });
      const staleRelation = await threads.createThread(testPrincipal, {
        providerId: "codex",
        prompt: "Stale cross-project relation",
        projectId: "matrix-os",
        taskId: otherTaskResult.task.id,
        clientRequestId: "req_owner_stale_relation",
      });
      const projectWorkspaces = createOwnerCodingAgentProjectWorkspaceStore({
        homePath,
        threads,
        principalOwnerIds: [testPrincipal.userId],
        now: () => new Date(now),
      });
      const app = new Hono();
      app.route("/api/coding-agents", createCodingAgentRoutes({
        service: { getSummary: vi.fn() },
        projectWorkspaces,
        getPrincipal: () => testPrincipal,
      }));

      const response = await app.request("/api/coding-agents/projects/matrix-os/workspace");
      const workspace = await response.json() as {
        project: { threadCount: number };
        tasks: { items: Array<{ id: string; threadCount: number }> };
        projectThreads: { items: Array<{ id: string; taskId?: string }> };
        taskThreads: { items: Array<{ id: string; taskId?: string }> };
      };

      expect(response.status).toBe(200);
      expect(workspace.tasks.items).toEqual([
        expect.objectContaining({ id: taskResult.task.id, threadCount: 1 }),
      ]);
      expect(workspace.projectThreads.items).toHaveLength(1);
      expect(workspace.taskThreads.items).toEqual([
        expect.objectContaining({ taskId: taskResult.task.id }),
      ]);
      expect(workspace.project.threadCount).toBe(2);
      expect(JSON.stringify(workspace)).not.toContain(staleRelation.snapshot.thread.id);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("GW-008 caps independent thread windows and excludes nested or cross-owner data", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-agent-project-workspace-"));
    const threads = createCodingAgentThreadStore({
      homePath,
      providers: [{ providerId: "codex", startThread: () => [] }],
      now: () => new Date(now),
    });
    const otherPrincipal = { userId: "user_other", source: "jwt" as const };

    try {
      for (let index = 0; index < 52; index += 1) {
        await threads.createThread(testPrincipal, {
          providerId: "codex",
          prompt: `Project chat ${index}`,
          projectId: "matrix-os",
          clientRequestId: `req_project_${index}`,
        });
        await threads.createThread(testPrincipal, {
          providerId: "codex",
          prompt: `Task chat ${index}`,
          projectId: "matrix-os",
          taskId: "task_auth",
          clientRequestId: `req_task_${index}`,
        });
      }
      await threads.createThread(otherPrincipal, {
        providerId: "codex",
        prompt: "Private chat",
        projectId: "matrix-os",
        taskId: "task_auth",
        clientRequestId: "req_other_owner",
      });

      const projection = await threads.getProjectWorkspaceThreads(testPrincipal, "matrix-os", {
        taskLimit: 50,
        projectThreadLimit: 50,
        taskThreadLimit: 50,
      }, ["task_auth"]);

      expect(projection.projectThreads.items).toHaveLength(50);
      expect(projection.projectThreads.hasMore).toBe(true);
      expect(projection.projectThreads.nextCursor).toMatch(/^thread_/);
      expect(projection.taskThreads.items).toHaveLength(50);
      expect(projection.taskThreads.hasMore).toBe(true);
      expect(projection.taskAggregates).toEqual([
        expect.objectContaining({
          taskId: "task_auth",
          threadCount: 52,
          activeThreadCount: 52,
          attentionCount: 0,
        }),
      ]);
      expect(projection.threadCount).toBe(104);
      expect(JSON.stringify(projection)).not.toMatch(/Private chat|events|transcript|delta/);

      for (const staleCursor of [
        { projectThreadCursor: "thread_stale" },
        { taskThreadCursor: "thread_stale" },
      ]) {
        await expect(threads.getProjectWorkspaceThreads(testPrincipal, "matrix-os", {
          taskLimit: 50,
          projectThreadLimit: 50,
          taskThreadLimit: 50,
          ...staleCursor,
        }, ["task_auth"])).rejects.toMatchObject({ code: "invalid_cursor" });
      }
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  }, 10_000);
});

function threadSummary(
  id: string,
  taskId?: string,
  status: "running" | "completed" = "completed",
  attention: "none" | "failed" = "none",
) {
  return {
    id,
    providerId: "codex",
    title: id.replace(/_/g, " "),
    status,
    attention,
    projectId: "matrix-os",
    ...(taskId ? { taskId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
