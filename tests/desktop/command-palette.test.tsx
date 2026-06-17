// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../../desktop/src/renderer/src/features/palette/CommandPalette";
import { useApps } from "../../desktop/src/renderer/src/stores/apps";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
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
    useTabs.setState({ tabs: [], activeTabId: null });
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
});
