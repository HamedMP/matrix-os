// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MissionControl from "../../desktop/src/renderer/src/features/mission-control/MissionControl";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useBoard, type Project } from "../../desktop/src/renderer/src/stores/board";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
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

// Requests stay pending: the panels around the board must not fail and log
// after the test ends, which Vitest reports as a teardown error.
function pendingApi(): ApiClient {
  const pending = () => new Promise<never>(() => undefined);
  const api: ApiClient = {
    get: vi.fn(pending),
    getText: vi.fn(pending),
    getBlob: vi.fn(pending),
    openStream: vi.fn(pending),
    post: vi.fn(pending),
    postBytes: vi.fn(pending),
    patch: vi.fn(pending),
    put: vi.fn(pending),
    putBytes: vi.fn(pending),
    delete: vi.fn(pending),
    putText: vi.fn(pending),
    forRuntime: () => api,
    forSession: () => api,
    baseUrl: "https://platform.test",
  };
  return api;
}

describe("MissionControl initial project selection", () => {
  beforeEach(() => {
    vi.stubGlobal("operator", {
      invoke: vi.fn(async () => ({ value: null })),
      on: vi.fn(() => () => undefined),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: pendingApi(),
    });
    useUi.setState({
      view: { kind: "board" },
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
