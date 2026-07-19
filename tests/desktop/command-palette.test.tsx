// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/renderer/src/lib/feature-flags", () => ({
  CODING_AGENTS_DESKTOP_WORKSPACE: true,
}));

import CommandPalette from "../../desktop/src/renderer/src/features/palette/CommandPalette";
import type { AgentThreadSummary, RuntimeSummary, TerminalSessionSummary } from "../../packages/contracts/src/index";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
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
  terminalSessions?: TerminalSessionSummary[];
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
    terminalSessions: { items: options.terminalSessions ?? [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
  };
}

function terminalSessionSummary(id: string, overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id,
    name: `matrix-${id}`,
    status: "running",
    attachable: true,
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

  it("opens terminal entries from canonical shell sessions, not workspace sessions", async () => {
    const openTab = vi.fn();
    useSessions.setState({
      sessions: [{ name: "Workspace Only", attachName: "workspace-only", status: "active", source: "workspace" }],
    });
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active" }],
    });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        terminalSessions: [
          terminalSessionSummary("term_matrix_main", {
            name: "matrix-main",
          }),
        ],
      }),
    });
    useTabs.setState({ openTab });

    render(<CommandPalette />);

    expect(screen.queryByText("Workspace Only")).toBeNull();
    expect(screen.queryByText("Open terminal matrix-main")).toBeNull();
    fireEvent.click(screen.getByText("matrix-main"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "matrix-main",
      title: "matrix-main",
    });
  });

  it("opens the coding-agent workspace from the command palette", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Open Agents"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
  });

  it("routes new agent runs to the coding-agent workspace composer", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });

    render(<CommandPalette />);

    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;
    fireEvent.click(screen.getByText("New agent run"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId + 1);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("does not request composer focus when thread creation is unavailable", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useCodingAgentWorkspace.setState({ summary: runtimeSummaryWithThreads() });

    render(<CommandPalette />);

    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;
    fireEvent.click(screen.getByText("New agent run"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("opens loaded coding-agent reviews from the command palette", async () => {
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
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_desktop_1");
  });

  it("opens loaded coding-agent threads from the command palette", async () => {
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
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_alpha");
  });

  it("opens attachable coding-agent terminal sessions from the command palette", async () => {
    const openTab = vi.fn();
    useTabs.setState({ openTab });
    useShellSessions.setState({ sessions: [] });
    useCodingAgentWorkspace.setState({
      summary: runtimeSummaryWithThreads({
        terminalSessions: [
          terminalSessionSummary("term_attached_1", {
            name: "matrix-review-758",
            cwdLabel: "matrix-os",
          }),
          terminalSessionSummary("term_unavailable_1", {
            name: "matrix-stale-review",
            status: "stale",
            attachable: false,
          }),
          terminalSessionSummary("term_invalid_name_1", {
            name: "Matrix-Review.123",
          }),
          terminalSessionSummary("term_invalid_name_2", {
            name: "matrix-review-",
          }),
        ],
      }),
    });

    render(<CommandPalette />);

    expect(screen.getByText("Open terminal matrix-review-758")).toBeTruthy();
    expect(screen.queryByText("Open terminal matrix-stale-review")).toBeNull();
    expect(screen.queryByText("Open terminal Matrix-Review.123")).toBeNull();
    expect(screen.queryByText("Open terminal matrix-review-")).toBeNull();

    fireEvent.click(screen.getByText("Open terminal matrix-review-758"));

    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "matrix-review-758",
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
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_duplicate");
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
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_recent");
  });

  it("opens provider setup actions in a foreground terminal from the command palette", async () => {
    const openTab = vi.fn();
    const post = vi.fn().mockResolvedValue({ name: "matrix-setup-codex-a1b2c3" });
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
        terminals: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex"));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/api/terminal/sessions", {
        name: expect.stringMatching(/^matrix-setup-codex-[a-z0-9]{6}$/),
        cwd: "projects",
        cmd: "npm install -g --prefix \"$MATRIX_NODE_PREFIX\" @openai/codex@0.144.6",
      });
    });
    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "matrix-setup-codex-a1b2c3",
      title: "Install Codex",
    });
  });

  it("uses distinct setup session names for similar provider setup actions", async () => {
    const openTab = vi.fn();
    const post = vi.fn()
      .mockResolvedValueOnce({ name: "matrix-setup-codex-alp-111111" })
      .mockResolvedValueOnce({ name: "matrix-setup-codex-alp-222222" });
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
        terminals: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex One"));
    fireEvent.click(screen.getByText("Install Codex Two"));

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(2);
    });
    const firstName = (post.mock.calls[0]![1] as { name: string }).name;
    const secondName = (post.mock.calls[1]![1] as { name: string }).name;
    expect(firstName).not.toBe(secondName);
    expect(firstName).toMatch(/^matrix-setup-[a-z0-9-]{1,18}$/);
    expect(secondName).toMatch(/^matrix-setup-[a-z0-9-]{1,18}$/);
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
        terminals: { items: [], hasMore: false, limit: 20 },
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
        terminals: { items: [], hasMore: false, limit: 20 },
      },
    });

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Install Codex"));

    expect(screen.getByText("Connect to your Matrix computer before opening setup.")).toBeTruthy();
    expect(screen.getByLabelText("Command palette")).toBeTruthy();
    expect(openTab).not.toHaveBeenCalled();
  });
});
