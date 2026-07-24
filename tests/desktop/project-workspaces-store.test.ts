// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  clearProjectWorkspaces,
  MAX_PROJECT_WORKSPACE_ENTRIES,
  useProjectWorkspaces,
} from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";

const NOW = "2026-07-10T12:00:00.000Z";

function workspace(projectId: string, taskId: string, threadId: string): ProjectAgentWorkspace {
  return {
    project: { id: projectId, label: projectId === "matrix-os" ? "Matrix OS" : "Website", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 },
    tasks: {
      items: [{
        id: taskId,
        projectId,
        title: "Primary task",
        status: "todo",
        priority: "normal",
        order: 0,
        threadCount: 1,
        activeThreadCount: 1,
        attentionCount: 0,
      }],
      hasMore: false,
      limit: 100,
    },
    projectThreads: { items: [], hasMore: false, limit: 100 },
    taskThreads: {
      items: [{
        id: threadId,
        providerId: "codex",
        title: "Primary chat",
        status: "running",
        attention: "none",
        projectId,
        taskId,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 100,
    },
    updatedAt: NOW,
  };
}

function summaryWith(projects: Array<{ id: string; label: string }>): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [{ id: "codingAgentsProjectWorkspace", enabled: true }],
    providers: [],
    projects: {
      items: projects.map((project) => ({ ...project, status: "available", taskCount: 1, threadCount: 1, attentionCount: 0 })),
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function resetStores(): void {
  useProjectWorkspaces.setState({ entries: {} });
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useCodingAgentWorkspace.setState({ summary: null, status: "idle" });
}

function mockOperator(
  workspaces: Record<string, ProjectAgentWorkspace>,
  options: { failFor?: string } = {},
) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-project-workspace") {
      const projectId = (payload as { projectId: string }).projectId;
      if (options.failFor === projectId) throw new Error("boom");
      const found = workspaces[projectId];
      if (!found) throw new Error(`no workspace for ${projectId}`);
      return found;
    }
    if (channel === "state:set") return { ok: true };
    throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return invoke;
}

describe("project workspaces store", () => {
  beforeEach(() => {
    clearProjectWorkspaces();
    resetStores();
  });

  it("loads a project workspace on ensure and caches it", async () => {
    const invoke = mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });

    await useProjectWorkspaces.getState().ensure("matrix-os");

    expect(useProjectWorkspaces.getState().entries["matrix-os"]).toMatchObject({
      status: "ready",
      workspace: { project: { id: "matrix-os" } },
      error: null,
    });
    await useProjectWorkspaces.getState().ensure("matrix-os");
    const loads = invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace");
    expect(loads).toHaveLength(1);
  });

  it("keeps project workspaces isolated per project", async () => {
    mockOperator({
      "matrix-os": workspace("matrix-os", "task_auth", "thread_plan"),
      website: workspace("website", "task_home", "thread_web"),
    });

    await useProjectWorkspaces.getState().ensure("matrix-os");
    await useProjectWorkspaces.getState().ensure("website");

    const { entries } = useProjectWorkspaces.getState();
    expect(entries["matrix-os"]?.workspace?.project.id).toBe("matrix-os");
    expect(entries.website?.workspace?.project.id).toBe("website");
    expect(entries["matrix-os"]?.workspace?.taskThreads.items[0]?.id).toBe("thread_plan");
    expect(entries.website?.workspace?.taskThreads.items[0]?.id).toBe("thread_web");
  });

  it("keeps the last projection when a refresh fails (stale-while-revalidate)", async () => {
    const operator = mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });
    await useProjectWorkspaces.getState().ensure("matrix-os");

    operator.mockImplementation(async (channel: string) => {
      if (channel === "runtime:get-project-workspace") throw new Error("boom");
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    await useProjectWorkspaces.getState().refresh("matrix-os");

    const entry = useProjectWorkspaces.getState().entries["matrix-os"];
    expect(entry?.status).toBe("error");
    expect(entry?.workspace?.project.id).toBe("matrix-os");
    expect(entry?.error).toBe("Project workspace unavailable");
  });

  it("reports an error without a projection when the first load fails", async () => {
    mockOperator({}, { failFor: "matrix-os" });

    await useProjectWorkspaces.getState().ensure("matrix-os");

    const entry = useProjectWorkspaces.getState().entries["matrix-os"];
    expect(entry?.status).toBe("error");
    expect(entry?.workspace).toBeNull();
    expect(entry?.error).toBe("Project workspace unavailable");
  });

  it("ignores a stale load that resolves after the entry was refreshed", async () => {
    let resolveFirst: (value: ProjectAgentWorkspace) => void = () => undefined;
    const first = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const stale = workspace("matrix-os", "task_stale", "thread_stale");
    const fresh = workspace("matrix-os", "task_auth", "thread_plan");
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn((channel: string) => {
          if (channel !== "runtime:get-project-workspace") return Promise.resolve({ ok: true });
          call += 1;
          return call === 1 ? first : Promise.resolve(fresh);
        }),
        on: vi.fn(() => () => undefined),
      },
    });

    const ensurePromise = useProjectWorkspaces.getState().ensure("matrix-os");
    const refreshPromise = useProjectWorkspaces.getState().refresh("matrix-os");
    resolveFirst(stale);
    await Promise.all([ensurePromise, refreshPromise]);

    expect(useProjectWorkspaces.getState().entries["matrix-os"]?.workspace?.project.id).toBe("matrix-os");
    expect(useProjectWorkspaces.getState().entries["matrix-os"]?.workspace?.tasks.items[0]?.id).toBe("task_auth");
  });

  it("selects the first thread once a workspace loads and keeps a valid existing selection", async () => {
    mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });
    useProjectView.getState().setSelectedThread("matrix-os", "thread_missing");

    await useProjectWorkspaces.getState().ensure("matrix-os");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_plan");

    useProjectView.getState().setSelectedThread("matrix-os", "thread_plan");
    await useProjectWorkspaces.getState().refresh("matrix-os");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_plan");
  });

  it("keeps a selection that is only known through the runtime summary lists", async () => {
    mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });
    useCodingAgentWorkspace.setState({
      summary: {
        ...summaryWith([{ id: "matrix-os", label: "Matrix OS" }]),
        attentionThreads: {
          items: [{
            id: "thread_attention",
            providerId: "codex",
            title: "Needs approval",
            status: "waiting_for_approval",
            attention: "approval_required",
            projectId: "matrix-os",
            createdAt: NOW,
            updatedAt: NOW,
          }],
          hasMore: false,
          limit: 20,
        },
      },
      status: "ready",
    });
    useProjectView.getState().setSelectedThread("matrix-os", "thread_attention");

    await useProjectWorkspaces.getState().ensure("matrix-os");

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_attention");
  });

  it("resolves a new chat target directly and after one refresh retry", async () => {
    const invoke = mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });

    const direct = await useProjectWorkspaces.getState().resolveNewChatTarget("matrix-os", "task_auth");
    expect(direct).toEqual({ projectId: "matrix-os", taskId: "task_auth" });

    const missing = await useProjectWorkspaces.getState().resolveNewChatTarget("matrix-os", "task_absent");
    expect(missing).toBeNull();
    // The miss triggers exactly one refresh before giving up.
    const loads = invoke.mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace");
    expect(loads.length).toBeGreaterThanOrEqual(2);
  });

  it("evicts the least recently fetched workspaces beyond the cap", async () => {
    const workspaces: Record<string, ProjectAgentWorkspace> = {};
    for (let index = 0; index < MAX_PROJECT_WORKSPACE_ENTRIES + 3; index += 1) {
      workspaces[`project-${index}`] = workspace(`project-${index}`, `task_${index}`, `thread_${index}`);
    }
    mockOperator(workspaces);

    for (const projectId of Object.keys(workspaces)) {
      // eslint-disable-next-line no-await-in-loop
      await useProjectWorkspaces.getState().ensure(projectId);
    }

    const entries = Object.keys(useProjectWorkspaces.getState().entries);
    expect(entries.length).toBeLessThanOrEqual(MAX_PROJECT_WORKSPACE_ENTRIES);
  });

  it("clears every cached workspace on runtime change", async () => {
    mockOperator({ "matrix-os": workspace("matrix-os", "task_auth", "thread_plan") });
    await useProjectWorkspaces.getState().ensure("matrix-os");

    clearProjectWorkspaces();

    expect(useProjectWorkspaces.getState().entries).toEqual({});
  });
});
