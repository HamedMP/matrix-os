// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MissionControl from "../../desktop/src/renderer/src/features/mission-control/MissionControl";
import { codingAgentRuntimeScope } from "../../desktop/src/shared/coding-agent-project-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useBoard, type Project } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { clearDesktopApps } from "./apps-query-test-utils";
vi.mock("../../desktop/src/renderer/src/features/desktop-shell/NativeDesktopShell", () => ({
  default: () => <div data-testid="native-desktop-shell" />,
}));
vi.mock("../../desktop/src/renderer/src/features/embeds/EmbedHost", () => ({
  default: () => <div data-testid="embed-host" />,
}));
vi.mock("../../desktop/src/renderer/src/features/workspace/TaskWorkspace", () => ({
  default: () => <div data-testid="task-workspace" />,
}));
vi.mock("../../desktop/src/renderer/src/features/settings/SettingsView", () => ({
  default: () => <div data-testid="settings-view" />,
}));
vi.mock("../../desktop/src/renderer/src/features/threads/Composer", () => ({
  default: () => <div data-testid="composer" />,
}));
vi.mock("../../desktop/src/renderer/src/features/palette/CommandPalette", () => ({
  default: () => <div data-testid="command-palette" />,
}));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({
  default: () => <button type="button">Getting started</button>,
}));
vi.mock("../../desktop/src/renderer/src/features/mission-control/shortcuts", () => ({
  useGlobalShortcuts: () => undefined,
}));
vi.mock("../../desktop/src/renderer/src/lib/kernel-wiring", () => ({
  wireKernel: () => () => undefined,
}));

describe("MissionControl", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clearDesktopApps();
    useTabs.setState(useTabs.getInitialState(), true);
    useShellSessions.setState({
      ...useShellSessions.getInitialState(),
      load: vi.fn().mockResolvedValue([]),
    });
  });

  it("uses the native desktop shell instead of permanent sidebar chrome", () => {
    render(<MissionControl />);

    expect(screen.getByTestId("native-desktop-shell")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("mission-control-content-surface")).toBeNull();
    expect(useTabs.getState().tabs).toEqual([]);
  });

  afterEach(() => {
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
      composerOpen: false,
      paletteOpen: false,
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

  it("loads canonical shell sessions immediately for the signed-in desktop", async () => {
    const api = { get: vi.fn() };
    const load = vi.fn().mockResolvedValue([]);
    useShellSessions.setState({ load });
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);

    await waitFor(() => expect(load).toHaveBeenCalledWith(api));
  });

  it("warms the app catalog before the Apps tab is opened", async () => {
    const api = { get: vi.fn().mockResolvedValue({ apps: [] }) };
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/apps", expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("warms resolved catalog icons during desktop startup", async () => {
    const api = { get: vi.fn().mockResolvedValue({ apps: [{ slug: "notes", name: "Notes" }] }) };
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);

    await waitFor(() => expect(document.head.querySelector('link[href="https://platform.test/icons/notes.png"]')).not.toBeNull());
  });

  it("restarts shell synchronization when the selected runtime changes", async () => {
    const api = { get: vi.fn() };
    const load = vi.fn().mockResolvedValue([]);
    useShellSessions.setState({ load });
    useBoard.setState({ loadProjects: vi.fn(async () => undefined) });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });

    render(<MissionControl />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    act(() => useConnection.setState({ runtimeSlot: "preview" }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
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
});
