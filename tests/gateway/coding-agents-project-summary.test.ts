import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index.js";
import {
  createCodingAgentProjectSummaryStore,
  createOwnerCodingAgentProjectSummaryStore,
} from "../../packages/gateway/src/coding-agents/project-summary.js";
import { createCodingAgentRuntimeSummaryService } from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createTaskManager } from "../../packages/gateway/src/task-manager.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-07-10T10:00:00.000Z");

function project(slug: string, name: string, updatedAt: string) {
  return {
    id: `proj_${slug}`,
    name,
    slug,
    localPath: `/home/matrix/home/projects/${slug}/repo`,
    addedAt: updatedAt,
    updatedAt,
    ownerScope: { type: "user" as const, id: testPrincipal.userId },
  };
}

describe("coding agent project runtime summaries", () => {
  it("GW-001 wires canonical owner project and task services", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-agent-project-summary-"));
    try {
      const projectManager = createProjectManager({ homePath, now: () => now.toISOString() });
      const taskManager = createTaskManager({ homePath, now: () => now.toISOString() });
      await projectManager.createProject({
        mode: "scratch",
        slug: "matrix-os",
        name: "Matrix OS",
        ownerScope: { type: "user", id: testPrincipal.userId },
      });
      await taskManager.createTask("matrix-os", {
        title: "Harden authentication",
        status: "running",
        priority: "high",
      });
      const projects = createOwnerCodingAgentProjectSummaryStore({
        homePath,
        principalOwnerIds: [testPrincipal.userId],
      });
      const service = createCodingAgentRuntimeSummaryService({ homePath, projects, now: () => now });

      const summary = await service.getSummary(testPrincipal);

      expect(summary.projects.items).toEqual([
        expect.objectContaining({ id: "matrix-os", label: "Matrix OS", taskCount: 1 }),
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("GW-001 hydrates canonical projects with bounded task and thread counts", async () => {
    const projectManager = {
      listManagedProjects: vi.fn(async () => ({
        projects: [
          project("matrix-os", "Matrix OS", "2026-07-10T09:00:00.000Z"),
          project("website", "Website", "2026-07-10T08:00:00.000Z"),
        ],
        nextCursor: null,
      })),
    };
    const taskManager = {
      listTasks: vi.fn(async (projectId: string) => ({
        ok: true as const,
        tasks: projectId === "matrix-os"
          ? [{ id: "task_auth" }, { id: "task_runtime" }]
          : [{ id: "task_docs" }],
        nextCursor: null,
      })),
    };
    const threads = {
      listProjectCounts: vi.fn(async () => [
        { projectId: "matrix-os", threadCount: 2, attentionCount: 1 },
        { projectId: "website", threadCount: 1, attentionCount: 0 },
      ]),
    };
    const projects = createCodingAgentProjectSummaryStore({
      projectManager,
      taskManager,
      threads,
      principalOwnerIds: [testPrincipal.userId],
    });
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      projects,
      now: () => now,
    });

    const summary = RuntimeSummarySchema.parse(await service.getSummary(testPrincipal));

    expect(summary.projects).toEqual({
      items: [
        {
          id: "matrix-os",
          label: "Matrix OS",
          status: "available",
          taskCount: 2,
          threadCount: 2,
          attentionCount: 1,
          updatedAt: "2026-07-10T09:00:00.000Z",
        },
        {
          id: "website",
          label: "Website",
          status: "available",
          taskCount: 1,
          threadCount: 1,
          attentionCount: 0,
          updatedAt: "2026-07-10T08:00:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    });
    expect(JSON.stringify(summary)).not.toMatch(/localPath|ownerScope|\/home\/matrix/);
    expect(projectManager.listManagedProjects).toHaveBeenCalledTimes(1);
    expect(taskManager.listTasks).toHaveBeenCalledTimes(2);
    expect(threads.listProjectCounts).toHaveBeenCalledWith(testPrincipal);
  });

  it("GW-001 uses exact bounded thread aggregates rather than paginated thread pages", async () => {
    const projects = createCodingAgentProjectSummaryStore({
      projectManager: {
        listManagedProjects: vi.fn(async () => ({
          projects: [project("matrix-os", "Matrix OS", now.toISOString())],
          nextCursor: null,
        })),
      },
      taskManager: {
        listTasks: vi.fn(async () => ({ ok: true as const, tasks: [], nextCursor: null })),
      },
      threads: {
        listProjectCounts: vi.fn(async () => [
          { projectId: "matrix-os", threadCount: 73, attentionCount: 11 },
        ]),
      },
      principalOwnerIds: [testPrincipal.userId],
    });

    const result = await projects.listProjectSummaries(testPrincipal, AbortSignal.timeout(100));

    expect(result.items[0]).toEqual(expect.objectContaining({
      threadCount: 73,
      attentionCount: 11,
    }));
  });

  it("GW-002 returns stable sorted projects with an explicit cap", async () => {
    const projects = createCodingAgentProjectSummaryStore({
      projectManager: {
        listManagedProjects: vi.fn(async () => ({
          projects: Array.from({ length: 55 }, (_, index) => {
            const projectIndex = 54 - index;
            return project(
              `project-${projectIndex.toString().padStart(2, "0")}`,
              `Project ${projectIndex}`,
              now.toISOString(),
            );
          }),
          nextCursor: null,
        })),
      },
      taskManager: {
        listTasks: vi.fn(async () => ({ ok: true as const, tasks: [], nextCursor: null })),
      },
      principalOwnerIds: [testPrincipal.userId],
    });
    const service = createCodingAgentRuntimeSummaryService({
      homePath: "/home/matrix/home",
      projects,
      now: () => now,
    });

    const summary = await service.getSummary(testPrincipal);

    expect(summary.projects.items).toHaveLength(50);
    expect(summary.projects.hasMore).toBe(true);
    expect(summary.projects.limit).toBe(50);
    expect(summary.projects.items.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `project-${index.toString().padStart(2, "0")}`),
    );
  });

  it("GW-002 bounds concurrent task summary reads", async () => {
    let active = 0;
    let peak = 0;
    const projects = createCodingAgentProjectSummaryStore({
      projectManager: {
        listManagedProjects: vi.fn(async () => ({
          projects: Array.from({ length: 50 }, (_, index) =>
            project(`project-${index}`, `Project ${index}`, now.toISOString())
          ),
          nextCursor: null,
        })),
      },
      taskManager: {
        listTasks: vi.fn(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return { ok: true as const, tasks: [], nextCursor: null };
        }),
      },
      principalOwnerIds: [testPrincipal.userId],
    });

    const result = await projects.listProjectSummaries(testPrincipal, AbortSignal.timeout(500));

    expect(result.items).toHaveLength(50);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("GW-003 degrades safely when project discovery fails or times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rawFailure = "Postgres failed at /home/matrix/private with token=secret-value";
    const projectStores = [
      {
        listProjectSummaries: vi.fn(async () => {
          throw new Error(rawFailure);
        }),
      },
      {
        listProjectSummaries: vi.fn(async (_principal: unknown, signal: AbortSignal) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { items: [], hasMore: false, limit: 50 };
        }),
      },
    ];

    try {
      for (const projects of projectStores) {
        warn.mockClear();
        const service = createCodingAgentRuntimeSummaryService({
          homePath: "/home/matrix/home",
          projects,
          projectSummaryTimeoutMs: 10,
          now: () => now,
        });

        const summary = await service.getSummary(testPrincipal);

        expect(summary.projects).toEqual({ items: [], hasMore: false, limit: 50 });
        expect(summary.capabilities).not.toContainEqual(
          expect.objectContaining({ id: "codingAgentsProjectWorkspace" }),
        );
        expect(JSON.stringify(summary)).not.toMatch(/Postgres|\/home\/matrix|secret-value/i);
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Postgres|\/home\/matrix|secret-value/i);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("GW-003 aborts a stalled canonical project dependency", async () => {
    const projects = createCodingAgentProjectSummaryStore({
      projectManager: {
        listManagedProjects: vi.fn(async () => ({
          projects: [project("matrix-os", "Matrix OS", now.toISOString())],
          nextCursor: null,
        })),
      },
      taskManager: {
        listTasks: vi.fn(() => new Promise<never>(() => undefined)),
      },
      principalOwnerIds: [testPrincipal.userId],
    });

    await expect(
      projects.listProjectSummaries(testPrincipal, AbortSignal.timeout(10)),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  }, 250);
});
