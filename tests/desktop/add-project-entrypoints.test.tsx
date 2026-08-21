// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../../desktop/src/renderer/src/features/palette/CommandPalette";
import ProjectsIndex from "../../desktop/src/renderer/src/features/project/ProjectsIndex";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("add-project entry points", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: null,
      imageUrl: null,
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    useTabs.setState({ tabs: [], activeTabId: null });
    useThreads.setState({ threads: [], activeThreadId: null });
    useCodingAgentWorkspace.setState({ summary: null, activeThreadId: null, reviews: null });
    useApps.setState({ apps: [], error: null });
    useUi.setState({ sidebarCollapsed: false, createProjectOpen: false, paletteOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the add-project dialog from the Projects index", () => {
    render(<ProjectsIndex />);

    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(useUi.getState().createProjectOpen).toBe(true);
  });

  it("offers an Add project action in the command palette", () => {
    useUi.setState({ paletteOpen: true });
    useShellSessions.setState({ ...useShellSessions.getInitialState(), load: vi.fn(async () => undefined) }, true);
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Add project…"));

    expect(useUi.getState().createProjectOpen).toBe(true);
    expect(useUi.getState().paletteOpen).toBe(false);
  });
});
