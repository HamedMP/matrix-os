// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MissionControl from "../../desktop/src/renderer/src/features/mission-control/MissionControl";
import { codingAgentRuntimeScope } from "../../desktop/src/shared/coding-agent-project-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useBoard, type Project } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useProviderUsage } from "../../desktop/src/renderer/src/stores/provider-usage";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

vi.mock("../../desktop/src/renderer/src/features/mission-control/Sidebar", () => ({
  default: () => <div data-testid="sidebar" />,
}));
vi.mock("../../desktop/src/renderer/src/features/mission-control/Titlebar", () => ({
  default: () => <div data-testid="titlebar" />,
}));
vi.mock("../../desktop/src/renderer/src/features/board/Board", () => ({
  default: () => <div data-testid="board" />,
}));
vi.mock("../../desktop/src/renderer/src/features/embeds/EmbedHost", () => ({
  default: () => <div data-testid="embed-host" />,
}));
vi.mock("../../desktop/src/renderer/src/features/workspace/TaskWorkspace", () => ({
  default: () => <div data-testid="task-workspace" />,
}));
vi.mock("../../desktop/src/renderer/src/features/threads/ThreadView", () => ({
  default: () => <div data-testid="thread-view" />,
}));
vi.mock("../../desktop/src/renderer/src/features/sessions/SessionsView", () => ({
  default: () => <div data-testid="sessions-view" />,
}));
vi.mock("../../desktop/src/renderer/src/features/settings/SettingsView", () => ({
  default: () => <div data-testid="settings-view" />,
}));
vi.mock("../../desktop/src/renderer/src/features/sessions/StandaloneSession", () => ({
  default: () => <div data-testid="standalone-session" />,
}));
vi.mock("../../desktop/src/renderer/src/features/threads/Composer", () => ({
  default: () => <div data-testid="composer" />,
}));
vi.mock("../../desktop/src/renderer/src/features/palette/CommandPalette", () => ({
  default: () => <div data-testid="command-palette" />,
}));
vi.mock("../../desktop/src/renderer/src/features/mission-control/shortcuts", () => ({
  useGlobalShortcuts: () => undefined,
}));
vi.mock("../../desktop/src/renderer/src/lib/kernel-wiring", () => ({
  wireKernel: () => () => undefined,
}));

describe("MissionControl", () => {
  const providerUsageActions = {
    ensureRuntimeScope: useProviderUsage.getState().ensureRuntimeScope,
    refresh: useProviderUsage.getState().refresh,
    clear: useProviderUsage.getState().clear,
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useConnection.setState({
      status: "loading",
      handle: null,
      platformHost: "",
      runtimeSlot: "primary",
      api: null,
    });
    useBoard.setState({
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
      firstLoadPending: false,
      refreshing: false,
      error: null,
    });
    useUi.setState({
      view: { kind: "board" },
      createTaskOpen: false,
      composerOpen: false,
      paletteOpen: false,
    });
    useProviderUsage.setState({
      status: "idle",
      response: null,
      runtimeScope: null,
      error: null,
      ...providerUsageActions,
    });
  });

  it("logs restore selection failures instead of detaching the rejected promise", async () => {
    const projects: Project[] = [{ slug: "saved-project", name: "Saved Project" }];
    const api = { get: vi.fn() };
    const loadProjects = vi.fn(async () => {
      useBoard.setState({ projects });
    });
    const selectProject = vi.fn(async () => {
      throw new Error("project refresh failed");
    });
    const invoke = vi.fn(async () => ({ value: "saved-project" }));
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn(),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });
    useBoard.setState({
      loadProjects,
      selectProject,
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
    });

    render(<MissionControl />);

    await waitFor(() => {
      expect(selectProject).toHaveBeenCalledWith(api, "saved-project");
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[mission-control] restore last project failed:",
      "project refresh failed",
    );
  });

  it("selects a valid project from the new runtime instead of restoring a stale slug", async () => {
    const api = { get: vi.fn() };
    const loadProjects = vi.fn(async () => {
      const runtimeSlot = useConnection.getState().runtimeSlot;
      useBoard.setState({
        projects: runtimeSlot === "preview"
          ? [{ slug: "preview-project", name: "Preview Project" }]
          : [{ slug: "main-project", name: "Main Project" }],
      });
    });
    const selectProject = vi.fn(async (_api, slug: string) => {
      useBoard.setState({ activeProjectSlug: slug });
    });
    vi.stubGlobal("operator", {
      invoke: vi.fn(async () => ({ value: "main-project" })),
      on: vi.fn(),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });
    useBoard.setState({ loadProjects, selectProject, projects: [], activeProjectSlug: null });

    render(<MissionControl />);
    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(api, "main-project"));

    act(() => {
      useBoard.setState({ projects: [], activeProjectSlug: null });
      useConnection.setState({ runtimeSlot: "preview" });
    });

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(api, "preview-project"));
    expect(useBoard.getState().activeProjectSlug).toBe("preview-project");
  });

  it("claims the runtime scope before the eager coding-agent refresh", async () => {
    const api = { get: vi.fn() };
    const ensureRuntimeScope = vi.fn();
    const refresh = vi.fn(async () => undefined);
    useCodingAgentWorkspace.setState({
      ensureRuntimeScope,
      refresh,
      notificationPreferencesStatus: "ready",
    });
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(ensureRuntimeScope).toHaveBeenCalledWith(codingAgentRuntimeScope(useConnection.getState()));
    expect(ensureRuntimeScope.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]!);
  });

  it("initializes provider usage for the authenticated runtime and refreshes while visible", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const api = { get: vi.fn() };
    const ensureRuntimeScope = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const clear = vi.fn();
    useProviderUsage.setState({ ensureRuntimeScope, refresh, clear });
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useCodingAgentWorkspace.setState({
      summary: {
        runtime: { id: "rt_primary", label: "Primary", status: "available" },
        capabilities: [{ id: "codingAgentsUsageSummary", enabled: true }],
        providers: [],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalSessions: { items: [], hasMore: false, limit: 20 },
        previewSessions: { items: [], hasMore: false, limit: 50 },
        recentActivity: { items: [], hasMore: false, limit: 20 },
        limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
        serverTime: "2026-08-10T12:00:00.000Z",
      },
      refresh: vi.fn(async () => undefined),
      notificationPreferencesStatus: "ready",
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);
    const scope = codingAgentRuntimeScope(useConnection.getState());
    expect(ensureRuntimeScope).toHaveBeenCalledWith(scope);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("clears provider usage at the sign-out boundary", async () => {
    const clear = vi.fn();
    useProviderUsage.setState({ clear });
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useCodingAgentWorkspace.setState({ summary: null });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get: vi.fn() } as never,
    });

    render(<MissionControl />);
    act(() => {
      useConnection.setState({ status: "signed-out", api: null, handle: null });
    });

    expect(clear).toHaveBeenCalled();
  });
});
