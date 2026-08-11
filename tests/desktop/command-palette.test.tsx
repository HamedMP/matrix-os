// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/renderer/src/lib/feature-flags", () => ({
  CODING_AGENTS_DESKTOP_WORKSPACE: true,
}));

import CommandPalette from "../../desktop/src/renderer/src/features/palette/CommandPalette";
import type { AgentThreadSummary, RuntimeSummary, TerminalTab } from "../../packages/contracts/src/index";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

function threadSummary(id: string, overrides: Partial<AgentThreadSummary> = {}): AgentThreadSummary {
  return {
    id,
    providerId: "codex",
    title: `Thread ${id}`,
    status: "running",
    attention: "none",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function runtimeSummaryWithThreads(options: {
  activeThreads?: AgentThreadSummary[];
  attentionThreads?: AgentThreadSummary[];
  terminalTabs?: TerminalTab[];
} = {}): RuntimeSummary {
  return {
    runtime: {
      id: "runtime-local",
      label: "Local Matrix",
      status: "available",
    },
    serverTime: "2026-07-07T00:00:00.000Z",
    capabilities: [{ id: "codingAgentsDesktopWorkspace", enabled: true }],
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 4096,
      maxListItems: 50,
    },
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: options.activeThreads ?? [], hasMore: false, limit: 20 },
    attentionThreads: { items: options.attentionThreads ?? [], hasMore: false, limit: 20 },
    terminalWorkspaces: {
      items: options.terminalTabs?.length ? [{
        id: "tws_00000000000000000000000000000001",
        scope: "project",
        projectId: "matrix-os",
        canonicalSize: { cols: 120, rows: 36 },
        status: "running",
        revision: 1,
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:00:00.000Z",
        tabs: options.terminalTabs,
      }] : [],
      hasMore: false,
      limit: 20,
    },
    previewSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
  };
}

function terminalTabSummary(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    workspaceId: "tws_00000000000000000000000000000001",
    name: `matrix-${id}`,
    status: "running",
    cwd: "projects/matrix-os",
    revision: 1,
    order: 0,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("CommandPalette", () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverStub,
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    useUi.setState({ paletteOpen: true, createTaskOpen: false, createProjectOpen: false, composerOpen: false });
    useBoard.setState({ activeProjectSlug: null, projects: [], cardsByProject: {} });
    useSessions.setState({ sessions: [] });
    useShellSessions.setState({ ...useShellSessions.getInitialState(), load: vi.fn().mockResolvedValue(undefined) }, true);
    useTabs.setState({ tabs: [], activeTabId: null, openTab: vi.fn() });
    useProjectView.setState({ entries: {}, runtimeScope: null });
    useProjectWorkspaces.setState({ entries: {} });
    useProjectChatLauncher.setState({ composerRequest: null });
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
    useCodingAgentWorkspace.setState({
      summary: null,
      reviewsStatus: "idle",
      reviews: null,
      reviewsError: null,
      selectedReviewId: null,
      selectReview: vi.fn().mockResolvedValue(undefined),
      loadThreadSnapshot: vi.fn().mockResolvedValue(undefined),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get: vi.fn() } as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("forces an app catalog retry after a previous palette load failed", async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useApps.setState({
      apps: [],
      loaded: true,
      loading: false,
      error: "server",
      load,
    });

    render(<CommandPalette />);

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith(useConnection.getState().api, true);
    });
  });

  it("does not duplicate a workspace tab already represented by the terminal store", async () => {
    const openTab = vi.fn();
    useSessions.setState({
      sessions: [{ name: "Workspace Only", attachName: "workspace-only", status: "active", source: "workspace" }],
    });
    useShellSessions.setState({
      sessions: [{
        name: "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001",
        workspaceId: "tws_00000000000000000000000000000001",
        tabId: "tt_00000000000000000000000000000001",
        revision: 1,
        workspaceRevision: 1,
        cwd: "projects/matrix-os",
        status: "active",
        subtitle: "matrix-main",
      }],
    });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        terminalTabs: [
          terminalTabSummary("tt_00000000000000000000000000000001", {
            name: "matrix-main",
          }),
        ],
      }),
    });
    useTabs.setState({ openTab });

    render(<CommandPalette />);

    expect(screen.queryByText("Workspace Only")).toBeNull();
    expect(screen.queryByText("Open terminal matrix-main")).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
  });

  it("no longer offers a retired Agents workspace entry", async () => {
    render(<CommandPalette />);

    expect(screen.queryByText("Open Agents")).toBeNull();
  });

  it("opens project results on the sessions overview instead of restoring a stale subview", () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });
    useProjectView.setState({
      entries: {
        "matrix-os": { view: "board", selectedThreadId: "thread-old", touchedAt: Date.now() },
      },
    });

    render(<CommandPalette />);
    fireEvent.click(screen.getByText("Matrix OS"));

    expect(useProjectView.getState().viewFor("matrix-os")).toBe("overview");
    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
  });

  it("routes new agent runs into the default project's chats view", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
      activeProjectSlug: "matrix-os",
    });

    render(<CommandPalette />);

    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;
    fireEvent.click(screen.getByText("New agent run"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectChatLauncher.getState().composerRequest).toMatchObject({ projectId: "matrix-os" });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId + 1);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("opens the project chats view without composer focus when thread creation is unavailable", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
      activeProjectSlug: "matrix-os",
    });
    useCodingAgentWorkspace.setState({ summary: runtimeSummaryWithThreads() });

    render(<CommandPalette />);

    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;
    fireEvent.click(screen.getByText("New agent run"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(useProjectChatLauncher.getState().composerRequest).toBeNull();
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("falls back to the legacy composer when the runtime has no projects", async () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText("New agent run"));

    expect(useUi.getState().composerOpen).toBe(true);
  });

  it("opens loaded coding-agent reviews in their project's chats view", async () => {
    const openTab = vi.fn();
    const selectReview = vi.fn().mockResolvedValue(undefined);
    useTabs.setState({ openTab });
    useCodingAgentWorkspace.setState({
      reviewsStatus: "ready",
      reviews: {
        items: [
          {
            id: "rev_desktop_1",
            projectId: "matrix-os",
            worktreeId: "wt_desktop_1",
            status: "reviewing",
            pullRequestNumber: 758,
            round: 2,
            maxRounds: 3,
            reviewer: "matrix-reviewer",
            implementer: "matrix-implementer",
            findings: { total: 3, high: 1, medium: 1, low: 1 },
            updatedAt: "2026-07-06T00:02:00.000Z",
          },
        ],
        hasMore: false,
        limit: 50,
      },
      selectReview,
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Open review PR #758"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "matrix-os",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_desktop_1");
  });

  it("opens loaded coding-agent threads in their project's chats view", async () => {
    const openTab = vi.fn();
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useTabs.setState({ openTab });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        activeThreads: [
          threadSummary("thread_alpha", {
            title: "Fix settings route",
            projectId: "matrix-os",
            updatedAt: "2026-07-07T00:04:00.000Z",
          }),
        ],
      }),
      loadThreadSnapshot,
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Open thread Fix settings route"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "matrix-os",
    });
    await waitFor(() => expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha"));
  });

  it("opens attachable coding-agent terminal sessions from the command palette", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useShellSessions.setState({ sessions: [] });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        terminalTabs: [
          terminalTabSummary("tt_00000000000000000000000000000001", {
            name: "matrix-review-758",
          }),
          terminalTabSummary("tt_00000000000000000000000000000002", {
            name: "matrix-stale-review",
            status: "stale",
          }),
          terminalTabSummary("tt_00000000000000000000000000000003", {
            name: "Matrix-Review.123",
          }),
          terminalTabSummary("tt_00000000000000000000000000000004", {
            name: "matrix-review-",
          }),
        ],
      }),
    });

    render(<CommandPalette />);

    expect(screen.getByText("Open terminal matrix-review-758")).toBeTruthy();
    expect(screen.queryByText("Open terminal matrix-stale-review")).toBeNull();
    expect(screen.getByText("Open terminal Matrix-Review.123")).toBeTruthy();
    expect(screen.getByText("Open terminal matrix-review-")).toBeTruthy();

    fireEvent.click(screen.getByText("Open terminal matrix-review-758"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001",
      title: "matrix-review-758",
    });
  });

  it("dedupes attention and active thread commands before applying the palette cap", async () => {
    const openTab = vi.fn();
    const loadThreadSnapshot = vi.fn().mockResolvedValue(undefined);
    useTabs.setState({ openTab });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        attentionThreads: [
          threadSummary("thread_attention", {
            title: "Review deploy approval",
            status: "waiting_for_approval",
            attention: "approval_required",
            updatedAt: "2026-07-07T00:06:00.000Z",
          }),
          threadSummary("thread_duplicate", {
            title: "Shared urgent thread",
            status: "waiting_for_input",
            attention: "input_required",
            projectId: "matrix-os",
            updatedAt: "2026-07-07T00:05:00.000Z",
          }),
        ],
        activeThreads: [
          threadSummary("thread_duplicate", {
            title: "Shared active thread",
            updatedAt: "2026-07-07T00:04:00.000Z",
          }),
          ...Array.from({ length: 20 }, (_, index) =>
            threadSummary(`thread_active_${index}`, {
              title: `Active thread ${index}`,
              updatedAt: `2026-07-07T00:${String(index).padStart(2, "0")}:00.000Z`,
            }),
          ),
        ],
      }),
      loadThreadSnapshot,
    });

    render(<CommandPalette />);

    expect(screen.getByText("Open thread Review deploy approval")).toBeTruthy();
    expect(screen.getByText("Open thread Shared urgent thread")).toBeTruthy();
    expect(screen.queryByText("Open thread Shared active thread")).toBeNull();
    expect(screen.queryByText("Open thread Active thread 18")).toBeNull();

    fireEvent.click(screen.getByText("Open thread Shared urgent thread"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "matrix-os",
    });
    await waitFor(() => expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_duplicate"));
  });

  it("prioritizes current reviews before slicing loaded command-palette reviews", async () => {
    const openTab = vi.fn();
    const selectReview = vi.fn().mockResolvedValue(undefined);
    useTabs.setState({ openTab });
    useCodingAgentWorkspace.setState({
      reviewsStatus: "ready",
      reviews: {
        items: [
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `rev_old_${index}`,
            projectId: "matrix-os",
            worktreeId: `wt_old_${index}`,
            status: "approved" as const,
            pullRequestNumber: 700 + index,
            round: 3,
            maxRounds: 3,
            reviewer: "matrix-reviewer",
            implementer: "matrix-implementer",
            updatedAt: `2026-07-05T00:${String(index).padStart(2, "0")}:00.000Z`,
          })),
          {
            id: "rev_recent",
            projectId: "matrix-os",
            worktreeId: "wt_recent",
            status: "reviewing",
            pullRequestNumber: 811,
            round: 1,
            maxRounds: 3,
            reviewer: "matrix-reviewer",
            implementer: "matrix-implementer",
            updatedAt: "2026-07-07T00:00:00.000Z",
          },
        ],
        hasMore: false,
        limit: 50,
      },
      selectReview,
    });

    render(<CommandPalette />);

    expect(screen.getByText("Open review PR #811")).toBeTruthy();
    expect(screen.queryByText("Open review PR #700")).toBeNull();

    fireEvent.click(screen.getByText("Open review PR #811"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "matrix-os",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_recent");
  });

  it("opens provider setup actions in a foreground terminal from the command palette", async () => {
    const openTab = vi.fn();
    const post = vi.fn(async (path: string) => path.endsWith("/ensure")
      ? { workspace: { id: "tws_00000000000000000000000000000001" } }
      : { tab: { id: "tt_00000000000000000000000000000001" } });
    useTabs.setState({ openTab });
    useConnection.setState({
      api: {
        get: vi.fn(),
        post,
      } as never,
    });
    useCodingAgentWorkspace.setState({
      summary: {
        target: {
          id: "runtime-local",
          label: "Local Matrix",
          status: "available",
        },
        serverTime: "2026-07-07T00:00:00.000Z",
        capabilities: [{ id: "codingAgentsDesktopWorkspace", enabled: true }],
        limits: {
          maxPromptBytes: 16384,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 4096,
          maxListItems: 50,
        },
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            kind: "codex",
            availability: "setup_required",
            installStatus: "missing",
            authStatus: "missing",
            supportedModes: ["default"],
            defaultMode: "default",
            setupActions: [
              {
                id: "codex",
                kind: "foreground_terminal",
                label: "Install Codex",
                command: "npm install -g --prefix \"$MATRIX_NODE_PREFIX\" @openai/codex@0.144.6",
              },
            ],
          },
        ],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex"));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/api/terminal/workspaces/tws_00000000000000000000000000000001/tabs", {
        name: "Install Codex",
        cwd: "projects",
        command: ["sh", "-lc", "npm install -g --prefix \"$MATRIX_NODE_PREFIX\" @openai/codex@0.144.6"],
      });
    });
    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001",
      title: "Install Codex",
    });
  });

  it("creates distinct setup tabs for similar provider actions", async () => {
    const openTab = vi.fn();
    let tab = 0;
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/ensure")) return { workspace: { id: "tws_00000000000000000000000000000001" } };
      tab += 1;
      return { tab: { id: `tt_${tab.toString(16).padStart(32, "0")}` } };
    });
    useTabs.setState({ openTab });
    useConnection.setState({
      api: {
        get: vi.fn(),
        post,
      } as never,
    });
    useCodingAgentWorkspace.setState({
      summary: {
        target: {
          id: "runtime-local",
          label: "Local Matrix",
          status: "available",
        },
        serverTime: "2026-07-07T00:00:00.000Z",
        capabilities: [{ id: "codingAgentsDesktopWorkspace", enabled: true }],
        limits: {
          maxPromptBytes: 16384,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 4096,
          maxListItems: 50,
        },
        providers: [
          {
            id: "codex-alpha-long-provider-one",
            displayName: "Codex One",
            kind: "codex",
            availability: "setup_required",
            installStatus: "missing",
            authStatus: "missing",
            supportedModes: ["default"],
            defaultMode: "default",
            setupActions: [
              {
                id: "setup",
                kind: "foreground_terminal",
                label: "Install Codex One",
                command: "echo setup-one",
              },
            ],
          },
          {
            id: "codex-alpha-long-provider-two",
            displayName: "Codex Two",
            kind: "codex",
            availability: "setup_required",
            installStatus: "missing",
            authStatus: "missing",
            supportedModes: ["default"],
            defaultMode: "default",
            setupActions: [
              {
                id: "setup",
                kind: "foreground_terminal",
                label: "Install Codex Two",
                command: "echo setup-two",
              },
            ],
          },
        ],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex One"));
    fireEvent.click(screen.getByText("Install Codex Two"));

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(4);
    });
    const tabCreates = post.mock.calls.filter(([path]) => String(path).endsWith("/tabs"));
    expect(tabCreates.map((call) => call[1])).toEqual([
      { name: "Install Codex One", cwd: "projects", command: ["sh", "-lc", "echo setup-one"] },
      { name: "Install Codex Two", cwd: "projects", command: ["sh", "-lc", "echo setup-two"] },
    ]);
  });

  it("keeps the palette open with a generic error when provider setup cannot create a terminal", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const post = vi.fn().mockRejectedValue(new Error("gateway failed at /home/matrix with token secret"));
    useConnection.setState({
      api: {
        get: vi.fn(),
        post,
      } as never,
    });
    useCodingAgentWorkspace.setState({
      summary: {
        target: {
          id: "runtime-local",
          label: "Local Matrix",
          status: "available",
        },
        serverTime: "2026-07-07T00:00:00.000Z",
        capabilities: [{ id: "codingAgentsDesktopWorkspace", enabled: true }],
        limits: {
          maxPromptBytes: 16384,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 4096,
          maxListItems: 50,
        },
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            kind: "codex",
            availability: "setup_required",
            installStatus: "missing",
            authStatus: "missing",
            supportedModes: ["default"],
            defaultMode: "default",
            setupActions: [
              {
                id: "codex",
                kind: "foreground_terminal",
                label: "Install Codex",
                command: "echo setup",
              },
            ],
          },
        ],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex"));

    expect(await screen.findByText("Could not open setup terminal. Try again from Terminal.")).toBeTruthy();
    expect(screen.getByLabelText("Command palette")).toBeTruthy();
    expect(screen.queryByText("/home/matrix")).toBeNull();
    expect(screen.queryByText("token secret")).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("[palette] Failed to open provider setup terminal:", "Error");
  });

  it("keeps disconnected provider setup actions visible with a recovery error", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useConnection.setState({ api: null });
    useCodingAgentWorkspace.setState({
      summary: {
        target: {
          id: "runtime-local",
          label: "Local Matrix",
          status: "offline",
        },
        serverTime: "2026-07-07T00:00:00.000Z",
        capabilities: [{ id: "codingAgentsDesktopWorkspace", enabled: true }],
        limits: {
          maxPromptBytes: 16384,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 4096,
          maxListItems: 50,
        },
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            kind: "codex",
            availability: "setup_required",
            installStatus: "missing",
            authStatus: "missing",
            supportedModes: ["default"],
            defaultMode: "default",
            setupActions: [
              {
                id: "codex",
                kind: "foreground_terminal",
                label: "Install Codex",
                command: "echo setup",
              },
            ],
          },
        ],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex"));

    expect(screen.getByText("Connect to your Matrix computer before opening setup.")).toBeTruthy();
    expect(screen.getByLabelText("Command palette")).toBeTruthy();
    expect(openTab).not.toHaveBeenCalled();
  });
});
