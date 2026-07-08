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
});
