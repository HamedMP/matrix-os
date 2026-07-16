// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentThreadComposerDraft, type AgentThreadSnapshot, type RuntimeSummary } from "@matrix-os/contracts";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

const NOW = "2026-07-12T12:00:00.000Z";

function summary(): RuntimeSummary {
  return {
    runtime: { id: "rt_preview", label: "Preview", status: "available" },
    capabilities: [{ id: "codingAgentsThreadCreate", enabled: true }],
    providers: [{
      id: "codex",
      kind: "codex",
      displayName: "Codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default"],
      defaultMode: "default",
      setupActions: [],
    }],
    projects: { items: [{ id: "desktop", label: "Desktop", status: "available", taskCount: 1, threadCount: 0, attentionCount: 0 }], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 24_000, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function snapshot(id: string, prompt: string): AgentThreadSnapshot {
  return {
    thread: {
      id,
      providerId: "codex",
      title: prompt,
      status: "queued",
      attention: "none",
      projectId: "desktop",
      taskId: "task_build",
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: { items: [], hasMore: false, limit: 200 },
  };
}

describe("project to task to chat flow", () => {
  beforeEach(() => {
    useBoard.setState(useBoard.getInitialState(), true);
    useCodingAgentProjectWorkspace.setState(useCodingAgentProjectWorkspace.getInitialState(), true);
    useCodingAgentWorkspace.setState(useCodingAgentWorkspace.getInitialState(), true);
  });

  it("creates canonical project/task routes, opens multiple task chats, and reopens either chat", async () => {
    const api = {
      get: vi.fn(async (path: string) => path === "/api/workspace/projects"
        ? { projects: [{ slug: "desktop", name: "Desktop", localPath: "/home/matrix/home/projects/desktop" }] }
        : { tasks: [], nextCursor: null }),
      post: vi.fn(async (path: string) => path === "/api/projects"
        ? { project: { slug: "desktop", name: "Desktop", localPath: "/home/matrix/home/projects/desktop" } }
        : { task: { id: "task_build", projectSlug: "desktop", title: "Build chat", status: "todo", priority: "normal", order: 0, previewIds: [], tags: [] } }),
    } as never;

    const project = await useBoard.getState().createProject(api, { name: "Desktop", mode: "scratch" });
    const task = await useBoard.getState().createTask(api, project!.slug, { title: "Build chat" });
    expect(api.post).toHaveBeenCalledWith("/api/projects", { name: "Desktop", mode: "scratch" });
    expect(api.post).toHaveBeenCalledWith("/api/projects/desktop/tasks", { title: "Build chat" });

    const runtimeSummary = summary();
    useCodingAgentWorkspace.setState({ summary: runtimeSummary, status: "ready" });
    useCodingAgentProjectWorkspace.setState({
      status: "ready",
      summary: runtimeSummary,
      selectedProjectId: "desktop",
      selectedTaskId: task!.id,
      workspace: {
        project: runtimeSummary.projects.items[0]!,
        tasks: { items: [{ id: task!.id, projectId: "desktop", title: task!.title, status: "todo", priority: "normal", order: 0, threadCount: 0, activeThreadCount: 0, attentionCount: 0 }], hasMore: false, limit: 100 },
        projectThreads: { items: [], hasMore: false, limit: 100 },
        taskThreads: { items: [], hasMore: false, limit: 100 },
        updatedAt: NOW,
      },
    });

    const created = [snapshot("thread_one", "First chat"), snapshot("thread_two", "Second chat")];
    window.operator = {
      invoke: vi.fn(async (channel: string, request: unknown) => {
        if (channel === "runtime:create-thread") return created.shift()!;
        if (channel === "runtime:get-thread-snapshot") {
          return snapshot((request as { threadId: string }).threadId, "Reopened chat");
        }
        if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") return { ok: true };
        throw new Error(`unexpected ${channel}`);
      }),
      on: vi.fn(() => () => undefined),
    };

    const base = defaultAgentThreadComposerDraft(runtimeSummary);
    const firstId = await useCodingAgentWorkspace.getState().createThread({ ...base, prompt: "First chat", projectId: "desktop", taskId: task!.id });
    const secondId = await useCodingAgentWorkspace.getState().createThread({ ...base, prompt: "Second chat", projectId: "desktop", taskId: task!.id });
    expect([firstId, secondId]).toEqual(["thread_one", "thread_two"]);
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:create-thread", expect.objectContaining({ projectId: "desktop", taskId: "task_build" }));

    await useCodingAgentWorkspace.getState().loadThreadSnapshot(firstId!);
    expect(useCodingAgentWorkspace.getState()).toMatchObject({ activeThreadId: "thread_one", threadSnapshot: { thread: { id: "thread_one" } } });
  });
});
