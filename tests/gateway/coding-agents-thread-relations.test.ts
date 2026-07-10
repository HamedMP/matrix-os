import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AgentThreadSnapshotSchema } from "../../packages/contracts/src/index.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import {
  createCodingAgentThreadRelationValidator,
} from "../../packages/gateway/src/coding-agents/thread-relations.js";
import {
  createCodingAgentThreadStore,
  type CodingAgentProviderAdapter,
} from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";

const ownerPrincipal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const otherPrincipal: RequestPrincipal = { userId: "other_user", source: "jwt" };
const now = "2026-07-10T11:00:00.000Z";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/coding-agents/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createBody = {
  providerId: "codex",
  prompt: "Inspect the project and propose the smallest safe change.",
  projectId: "matrix-os",
  mode: "default",
  approvalPolicy: "on_request",
  sandboxMode: "workspace_write",
  clientRequestId: "req_relation_create",
};

async function createHarness() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-relations-"));
  const projects = createProjectManager({ homePath, now: () => now });
  const tasks = createTaskManager({ homePath, now: () => now });
  await projects.createProject({
    mode: "scratch",
    slug: "matrix-os",
    name: "Matrix OS",
    ownerScope: { type: "user", id: ownerPrincipal.userId },
  });
  await projects.createProject({
    mode: "scratch",
    slug: "website",
    name: "Website",
    ownerScope: { type: "user", id: ownerPrincipal.userId },
  });
  const matrixTask = await tasks.createTask("matrix-os", {
    title: "Harden authentication",
    status: "running",
  });
  const websiteTask = await tasks.createTask("website", {
    title: "Publish docs",
    status: "todo",
  });
  if (!matrixTask.ok || !websiteTask.ok) throw new Error("task fixture failed");

  const startThread = vi.fn<NonNullable<CodingAgentProviderAdapter["startThread"]>>(() => []);
  const threads = createCodingAgentThreadStore({
    homePath,
    providers: [{ providerId: "codex", startThread }],
    relationValidator: createCodingAgentThreadRelationValidator({
      projectManager: projects,
      taskManager: tasks,
      principalOwnerIds: [ownerPrincipal.userId],
    }),
    now: () => new Date(now),
  });
  let principal = ownerPrincipal;
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: vi.fn() },
    threads,
    getPrincipal: () => principal,
  }));

  return {
    app,
    homePath,
    matrixTaskId: matrixTask.task.id,
    websiteTaskId: websiteTask.task.id,
    startThread,
    threads,
    setPrincipal(value: RequestPrincipal) {
      principal = value;
    },
  };
}

describe("coding agent thread project relations", () => {
  it("GW-010 treats the fixed task scan ceiling as a non-retryable invalid relation", async () => {
    let page = 0;
    const validator = createCodingAgentThreadRelationValidator({
      projectManager: {
        getProject: vi.fn(async () => ({ ok: true as const, project: { slug: "matrix-os" } })),
      },
      taskManager: {
        listTasks: vi.fn(async () => ({
          ok: true as const,
          tasks: [],
          nextCursor: `task_page_${page += 1}`,
        })),
      },
      principalOwnerIds: [ownerPrincipal.userId],
    });

    await expect(validator.validateCreate(ownerPrincipal, {
      ...createBody,
      taskId: "task_beyond_supported_scan",
    })).rejects.toMatchObject({ code: "invalid_relation" });
  });

  it("GW-009 GW-010 rejects invalid shell relations before provider launch or persistence", async () => {
    const harness = await createHarness();
    try {
      const invalidRequests = [
        { ...createBody, projectId: undefined, clientRequestId: "req_missing_project" },
        { ...createBody, projectId: "missing-project", clientRequestId: "req_stale_project" },
        {
          ...createBody,
          taskId: harness.websiteTaskId,
          clientRequestId: "req_cross_project_task",
        },
      ];

      for (const body of invalidRequests) {
        const response = await harness.app.request(jsonRequest(body));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            code: "thread_relation_invalid",
            safeMessage: "Choose an available project and task, then try again.",
            retryable: false,
          },
        });
      }

      harness.setPrincipal(otherPrincipal);
      const unauthorized = await harness.app.request(jsonRequest({
        ...createBody,
        clientRequestId: "req_unauthorized_project",
      }));
      expect(unauthorized.status).toBe(400);
      expect(await unauthorized.json()).toEqual({
        error: {
          code: "thread_relation_invalid",
          safeMessage: "Choose an available project and task, then try again.",
          retryable: false,
        },
      });

      expect(harness.startThread).not.toHaveBeenCalled();
      expect((await harness.threads.listThreads(ownerPrincipal)).items).toEqual([]);
      expect((await harness.threads.listThreads(otherPrincipal)).items).toEqual([]);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-009 creates a shell thread with an owned project and same-project task", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(jsonRequest({
        ...createBody,
        taskId: harness.matrixTaskId,
      }));
      const snapshot = AgentThreadSnapshotSchema.parse(await response.json());

      expect(response.status).toBe(202);
      expect(snapshot.thread).toMatchObject({
        projectId: "matrix-os",
        taskId: harness.matrixTaskId,
      });
      expect(harness.startThread).toHaveBeenCalledTimes(1);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-011 returns the original relation for an idempotent create retry", async () => {
    const harness = await createHarness();
    try {
      const first = await harness.app.request(jsonRequest({
        ...createBody,
        taskId: harness.matrixTaskId,
      }));
      const retry = await harness.app.request(jsonRequest({
        ...createBody,
        projectId: "missing-project",
        taskId: undefined,
      }));
      const firstSnapshot = AgentThreadSnapshotSchema.parse(await first.json());
      const retrySnapshot = AgentThreadSnapshotSchema.parse(await retry.json());

      expect(first.status).toBe(202);
      expect(retry.status).toBe(200);
      expect(retrySnapshot.thread).toEqual(firstSnapshot.thread);
      expect(retrySnapshot.thread).toMatchObject({
        projectId: "matrix-os",
        taskId: harness.matrixTaskId,
      });
      expect(harness.startThread).toHaveBeenCalledTimes(1);
    } finally {
      await rm(harness.homePath, { recursive: true, force: true });
    }
  });

  it("GW-009 maps relation dependency failures to a redacted recovery error", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-relation-failure-"));
    const startThread = vi.fn<NonNullable<CodingAgentProviderAdapter["startThread"]>>(() => []);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rawFailure = "Postgres failed at /home/matrix/private token=secret-value";
    try {
      const threads = createCodingAgentThreadStore({
        homePath,
        providers: [{ providerId: "codex", startThread }],
        relationValidator: {
          validateCreate: async () => { throw new Error(rawFailure); },
        },
      });
      const app = new Hono();
      app.route("/api/coding-agents", createCodingAgentRoutes({
        service: { getSummary: vi.fn() },
        threads,
        getPrincipal: () => ownerPrincipal,
      }));

      const response = await app.request(jsonRequest(createBody));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "thread_store_unavailable",
          safeMessage: "Agent thread state is temporarily unavailable. Try again.",
          retryable: true,
          recoveryActions: ["retry"],
        },
      });
      expect(startThread).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Postgres|\/home\/matrix|secret-value/i);
    } finally {
      warn.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
