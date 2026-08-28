// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  defaultProjectId,
  openCodingAgentThread,
  openProjectChat,
  useProjectChatLauncher,
} from "../../desktop/src/renderer/src/lib/project-chat";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const NOW = "2026-07-12T12:00:00.000Z";

function summaryWithThreads(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: {
      items: [{ id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 1, attentionCount: 0 }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: {
      items: [{
        id: "thread_alpha",
        providerId: "codex",
        title: "Fix settings route",
        status: "running",
        attention: "none",
        projectId: "matrix-os",
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function resetStores(): void {
  useTabs.setState(useTabs.getInitialState(), true);
  useBoard.setState({ projects: [], activeProjectSlug: null });
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useCodingAgentWorkspace.setState({ summary: null, status: "idle", activeThreadId: null });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "state:set") return { ok: true };
        throw new Error(`unexpected channel ${channel}`);
      }),
      on: vi.fn(() => () => undefined),
    },
  });
}

describe("openProjectChat", () => {
  beforeEach(() => {
    resetStores();
  });

  it("opens the project tab with the chats view active", () => {
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    openProjectChat("matrix-os");

    const tabs = useTabs.getState();
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0]).toMatchObject({
      kind: "work",
      workRoute: "project",
      projectSlug: "matrix-os",
      title: "Chat",
    });
    expect(tabs.activeTabId).toBe(tabs.tabs[0]!.id);
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
  });

  it("focuses the already-open project tab instead of duplicating it", () => {
    const first = useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });

    openProjectChat("matrix-os");

    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "work")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(first);
  });

  it("selects the requested thread and loads its snapshot", async () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });

    await openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_alpha");
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha");
  });

  it("does not promote an agent conversation when it is merely opened", async () => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-project-workspace") {
            return {
              project: summaryWithThreads().projects.items[0],
              tasks: { items: [], hasMore: false, limit: 100 },
              projectThreads: { items: summaryWithThreads().activeThreads.items, hasMore: false, limit: 100 },
              taskThreads: { items: [], hasMore: false, limit: 100 },
              updatedAt: NOW,
            };
          }
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    const loadThreadSnapshot = vi.fn(async (threadId: string) => {
      useCodingAgentWorkspace.setState({
        activeThreadId: threadId,
        threadSnapshotStatus: "ready",
        threadSnapshot: {
          thread: summaryWithThreads().activeThreads.items[0]!,
          events: { items: [], hasMore: false, limit: 200 },
        },
      });
    });
    useCodingAgentWorkspace.setState({ summary: summaryWithThreads(), status: "ready" });
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });

    const opened = openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );

    await opened;

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("does not record a Recent when the project workspace cannot load", async () => {
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-project-workspace") throw new Error("offline");
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot: vi.fn(async () => undefined),
    });

    await openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("does not record a Recent when the thread snapshot cannot load", async () => {
    useProjectWorkspaces.setState({
      entries: {
        "matrix-os": {
          status: "ready",
          workspace: {
            project: summaryWithThreads().projects.items[0]!,
            tasks: { items: [], hasMore: false, limit: 100 },
            projectThreads: { items: summaryWithThreads().activeThreads.items, hasMore: false, limit: 100 },
            taskThreads: { items: [], hasMore: false, limit: 100 },
            updatedAt: NOW,
          },
          error: null,
          fetchedAt: 1,
        },
      },
    });
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot: vi.fn(async (threadId: string) => {
        useCodingAgentWorkspace.setState({
          activeThreadId: threadId,
          threadSnapshotStatus: "error",
          threadSnapshot: null,
          threadSnapshotError: "Thread state unavailable",
        });
      }),
    });

    await openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("waits for an in-flight project workspace before recording a successful open", async () => {
    let resolveWorkspace!: (workspace: ProjectAgentWorkspace) => void;
    const workspaceResponse = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveWorkspace = resolve;
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-project-workspace") return workspaceResponse;
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    const loadThreadSnapshot = vi.fn(async (threadId: string) => {
      useCodingAgentWorkspace.setState({
        activeThreadId: threadId,
        threadSnapshotStatus: "ready",
        threadSnapshot: {
          thread: summaryWithThreads().activeThreads.items[0]!,
          events: { items: [], hasMore: false, limit: 200 },
        },
      });
    });
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot,
    });

    const loadingWorkspace = useProjectWorkspaces.getState().refresh("matrix-os");
    const openingConversation = openProjectChat("matrix-os", { threadId: "thread_alpha" });
    expect(useProjectWorkspaces.getState().entries["matrix-os"]?.status).toBe("loading");

    resolveWorkspace({
      project: summaryWithThreads().projects.items[0]!,
      tasks: { items: [], hasMore: false, limit: 100 },
      projectThreads: { items: summaryWithThreads().activeThreads.items, hasMore: false, limit: 100 },
      taskThreads: { items: [], hasMore: false, limit: 100 },
      updatedAt: NOW,
    });
    await Promise.all([loadingWorkspace, openingConversation]);

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("waits for the authoritative replacement when an in-flight workspace load is superseded", async () => {
    const workspaceResolvers: Array<(workspace: ProjectAgentWorkspace) => void> = [];
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-project-workspace") {
            return new Promise<ProjectAgentWorkspace>((resolve) => {
              workspaceResolvers.push(resolve);
            });
          }
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot: vi.fn(async (threadId: string) => {
        useCodingAgentWorkspace.setState({
          activeThreadId: threadId,
          threadSnapshotStatus: "ready",
          threadSnapshot: {
            thread: summaryWithThreads().activeThreads.items[0]!,
            events: { items: [], hasMore: false, limit: 200 },
          },
        });
      }),
    });
    const workspace = {
      project: summaryWithThreads().projects.items[0]!,
      tasks: { items: [], hasMore: false, limit: 100 },
      projectThreads: { items: summaryWithThreads().activeThreads.items, hasMore: false, limit: 100 },
      taskThreads: { items: [], hasMore: false, limit: 100 },
      updatedAt: NOW,
    } satisfies ProjectAgentWorkspace;

    const firstLoad = useProjectWorkspaces.getState().refresh("matrix-os");
    const openingConversation = openProjectChat("matrix-os", { threadId: "thread_alpha" });
    let openSettled = false;
    void openingConversation.then(() => {
      openSettled = true;
    });
    const replacementLoad = useProjectWorkspaces.getState().refresh("matrix-os");

    workspaceResolvers[0]!(workspace);
    await firstLoad;
    await Promise.resolve();
    const settledBeforeReplacement = openSettled;

    workspaceResolvers[1]!(workspace);
    await Promise.all([replacementLoad, openingConversation]);

    expect(settledBeforeReplacement).toBe(false);
    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("does not record a Recent when the project refreshes while the thread snapshot loads", async () => {
    let resolveWorkspace!: (workspace: ProjectAgentWorkspace) => void;
    let markThreadSnapshotStarted!: () => void;
    let resolveThreadSnapshot!: () => void;
    const workspaceResponse = new Promise<ProjectAgentWorkspace>((resolve) => {
      resolveWorkspace = resolve;
    });
    const threadSnapshotResponse = new Promise<void>((resolve) => {
      resolveThreadSnapshot = resolve;
    });
    const threadSnapshotStarted = new Promise<void>((resolve) => {
      markThreadSnapshotStarted = resolve;
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "runtime:get-project-workspace") return workspaceResponse;
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    const workspace = {
      project: summaryWithThreads().projects.items[0]!,
      tasks: { items: [], hasMore: false, limit: 100 },
      projectThreads: { items: summaryWithThreads().activeThreads.items, hasMore: false, limit: 100 },
      taskThreads: { items: [], hasMore: false, limit: 100 },
      updatedAt: NOW,
    } satisfies ProjectAgentWorkspace;
    useProjectWorkspaces.setState({
      entries: {
        "matrix-os": {
          status: "ready",
          workspace,
          error: null,
          fetchedAt: 1,
        },
      },
    });
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot: vi.fn(async (threadId: string) => {
        markThreadSnapshotStarted();
        await threadSnapshotResponse;
        useCodingAgentWorkspace.setState({
          activeThreadId: threadId,
          threadSnapshotStatus: "ready",
          threadSnapshot: {
            thread: summaryWithThreads().activeThreads.items[0]!,
            events: { items: [], hasMore: false, limit: 200 },
          },
        });
      }),
    });

    const openingConversation = openProjectChat("matrix-os", { threadId: "thread_alpha" });
    await threadSnapshotStarted;
    const replacementLoad = useProjectWorkspaces.getState().refresh("matrix-os");
    expect(useProjectWorkspaces.getState().entries["matrix-os"]?.status).toBe("loading");

    resolveThreadSnapshot();
    const opened = await openingConversation;

    resolveWorkspace(workspace);
    await replacementLoad;
    expect(opened).toBe(false);
    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_alpha" }),
    );
  });

  it("does not reload the snapshot for the already-active thread", () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot, activeThreadId: "thread_alpha" });

    openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(loadThreadSnapshot).not.toHaveBeenCalled();
  });

  it("leaves the current selection alone when no thread is given", () => {
    useProjectView.getState().setSelectedThread("matrix-os", "thread_kept");

    openProjectChat("matrix-os");

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_kept");
  });

  it("records a one-shot composer request when compose is requested", () => {
    openProjectChat("matrix-os", { compose: true });

    expect(useProjectChatLauncher.getState().composerRequest).toMatchObject({ projectId: "matrix-os" });
  });

  it("consumes a composer request exactly once", () => {
    openProjectChat("matrix-os", { compose: true });

    useProjectChatLauncher.getState().consumeComposer("matrix-os");

    expect(useProjectChatLauncher.getState().composerRequest).toBeNull();
  });
});

describe("openCodingAgentThread", () => {
  beforeEach(() => {
    resetStores();
  });

  it("routes a thread into its project from the runtime summary", async () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ summary: summaryWithThreads(), status: "ready", loadThreadSnapshot });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    await openCodingAgentThread("thread_alpha");

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "work", workRoute: "project", projectSlug: "matrix-os" });
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_alpha");
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha");
  });

  it("falls back to the loaded snapshot's project when the summary does not list the thread", () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({
      summary: summaryWithThreads(),
      status: "ready",
      loadThreadSnapshot,
      activeThreadId: "thread_orphan",
      threadSnapshot: {
        thread: {
          id: "thread_orphan",
          providerId: "codex",
          title: "Orphan",
          status: "running",
          attention: "none",
          projectId: "matrix-os",
          createdAt: NOW,
          updatedAt: NOW,
        },
        events: { items: [], hasMore: false, limit: 200 },
      },
    });

    openCodingAgentThread("thread_orphan");

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "work", workRoute: "project", projectSlug: "matrix-os" });
  });

  it("resolves an unknown thread's project from the runtime instead of guessing", async () => {
    // The thread is outside the bounded summary and no project workspace is
    // loaded, so nothing local knows its project. Guessing here would open the
    // conversation under an unrelated project with nothing to reroute it.
    const invoke = vi.fn(async (channel: string) => {
      if (channel !== "runtime:get-thread-snapshot") throw new Error(`unexpected channel ${channel}`);
      return {
        thread: {
          id: "thread_elsewhere",
          providerId: "codex",
          title: "Elsewhere",
          status: "running",
          attention: "none",
          projectId: "website",
          createdAt: NOW,
          updatedAt: NOW,
        },
        events: { items: [], hasMore: false, limit: 200 },
      };
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ summary: null, status: "idle", loadThreadSnapshot });
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }, { slug: "website", name: "Website" }],
      activeProjectSlug: "matrix-os",
    });

    await openCodingAgentThread("thread_elsewhere");

    // "website" comes from the runtime, not from whichever project was active.
    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "work", workRoute: "project", projectSlug: "website" });
  });

  it("uses the default project when the runtime cannot resolve the thread either", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("offline");
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ summary: null, status: "idle", loadThreadSnapshot });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    await openCodingAgentThread("thread_unknown");

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "work", workRoute: "project", projectSlug: "matrix-os" });
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_unknown");
  });

  it("does not record a fallback Recent when authoritative project resolution fails", async () => {
    let snapshotCalls = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:get-thread-snapshot") {
        snapshotCalls += 1;
        if (snapshotCalls === 1) throw new Error("offline");
        return {
          thread: {
            id: "thread_unknown",
            providerId: "codex",
            title: "Unknown",
            status: "running",
            attention: "none",
            projectId: "matrix-os",
            createdAt: NOW,
            updatedAt: NOW,
          },
          events: { items: [], hasMore: false, limit: 200 },
        };
      }
      if (channel === "runtime:get-project-workspace") {
        return {
          project: summaryWithThreads().projects.items[0],
          tasks: { items: [], hasMore: false, limit: 100 },
          projectThreads: { items: [], hasMore: false, limit: 100 },
          taskThreads: { items: [], hasMore: false, limit: 100 },
          updatedAt: NOW,
        };
      }
      if (channel === "state:set") return { ok: true };
      throw new Error(`unexpected channel ${channel}`);
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    await openCodingAgentThread("thread_unknown");

    expect(useTabs.getState().recentViews).not.toContainEqual(
      expect.objectContaining({ kind: "conversation", id: "thread_unknown" }),
    );
  });
});

describe("defaultProjectId", () => {
  beforeEach(() => {
    resetStores();
  });

  it("prefers the currently open Work Project route", () => {
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }, { slug: "website", name: "Website" }],
      activeProjectSlug: "website",
    });
    useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "work",
      workRoute: "project",
      projectSlug: "matrix-os",
    });

    expect(defaultProjectId()).toBe("matrix-os");
  });

  it("falls back to the board's active project, then the first project", () => {
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }, { slug: "website", name: "Website" }],
      activeProjectSlug: "website",
    });
    expect(defaultProjectId()).toBe("website");

    useBoard.setState({ activeProjectSlug: null });
    expect(defaultProjectId()).toBe("matrix-os");
  });

  it("returns null when there are no projects", () => {
    expect(defaultProjectId()).toBeNull();
  });
});
