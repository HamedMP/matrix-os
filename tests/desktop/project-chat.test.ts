// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSummary } from "@matrix-os/contracts";
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
  useTabs.setState({ tabs: [], activeTabId: null });
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
    expect(tabs.tabs[0]).toMatchObject({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    expect(tabs.activeTabId).toBe(tabs.tabs[0]!.id);
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
  });

  it("focuses the already-open project tab instead of duplicating it", () => {
    const first = useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });

    openProjectChat("matrix-os");

    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "project")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(first);
  });

  it("selects the requested thread and loads its snapshot", () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });

    openProjectChat("matrix-os", { threadId: "thread_alpha" });

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_alpha");
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha");
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

  it("routes a thread into its project from the runtime summary", () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ summary: summaryWithThreads(), status: "ready", loadThreadSnapshot });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    openCodingAgentThread("thread_alpha");

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "project", projectSlug: "matrix-os" });
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

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "project", projectSlug: "matrix-os" });
  });

  it("uses the default project when the thread's project is unknown", () => {
    const loadThreadSnapshot = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({ summary: null, status: "idle", loadThreadSnapshot });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });

    openCodingAgentThread("thread_unknown");

    expect(useTabs.getState().tabs[0]).toMatchObject({ kind: "project", projectSlug: "matrix-os" });
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_unknown");
  });
});

describe("defaultProjectId", () => {
  beforeEach(() => {
    resetStores();
  });

  it("prefers the currently open project tab", () => {
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }, { slug: "website", name: "Website" }],
      activeProjectSlug: "website",
    });
    useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });

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
