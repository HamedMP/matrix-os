// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
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

describe("MissionControl initial project selection", () => {
  beforeEach(() => {
    vi.stubGlobal("operator", {
      invoke: vi.fn(async () => ({ value: null })),
      on: vi.fn(() => () => undefined),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get: vi.fn() } as never,
    });
    useUi.setState({
      view: { kind: "board" },
      createTaskOpen: false,
      composerOpen: false,
      paletteOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
  });

  it("selects the first project after loading when none is active", async () => {
    const projects: Project[] = [{ slug: "alpha", name: "Alpha" }];
    const loadProjects = vi.fn(async () => {
      useBoard.setState({ projects });
    });
    const selectProject = vi.fn(async () => undefined);
    useBoard.setState({
      loadProjects,
      selectProject,
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
    });
    const api = useConnection.getState().api;

    render(<MissionControl />);

    await waitFor(() => {
      expect(selectProject).toHaveBeenCalledWith(api, "alpha");
    });
  });
});
