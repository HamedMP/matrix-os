// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MissionControl from "../../desktop/src/renderer/src/features/mission-control/MissionControl";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useBoard, type Project } from "../../desktop/src/renderer/src/stores/board";
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
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      createTaskOpen: false,
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
});
