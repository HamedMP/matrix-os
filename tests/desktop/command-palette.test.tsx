// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/renderer/src/lib/feature-flags", () => ({
  CODING_AGENTS_DESKTOP_WORKSPACE: true,
}));

import CommandPalette from "../../desktop/src/renderer/src/features/palette/CommandPalette";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

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
    useTabs.setState({ openTab });

    render(<CommandPalette />);

    expect(screen.queryByText("Workspace Only")).toBeNull();
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
      title: "Agents",
    });
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
      title: "Agents",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_desktop_1");
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
      title: "Agents",
    });
    expect(selectReview).toHaveBeenCalledWith("rev_recent");
  });

  it("opens provider setup actions in a foreground terminal from the command palette", async () => {
    const openTab = vi.fn();
    const post = vi.fn().mockResolvedValue({ name: "matrix-setup-codex" });
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
                command: "npm install -g --prefix \"$MATRIX_NODE_PREFIX\" @openai/codex@latest",
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
        name: "matrix-setup-codex",
        cwd: "projects",
        cmd: "npm install -g --prefix \"$MATRIX_NODE_PREFIX\" @openai/codex@latest",
      });
    });
    expect(openTab).toHaveBeenCalledWith({
      kind: "terminal",
      sessionName: "matrix-setup-codex",
      title: "Install Codex",
    });
  });
});
