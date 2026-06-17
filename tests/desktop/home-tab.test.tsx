// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeTab from "../../desktop/src/renderer/src/features/mission-control/HomeTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("HomeTab", () => {
  beforeEach(() => {
    vi.stubGlobal("operator", {
      invoke: vi.fn(async () => ({ embedId: "embed-test", state: "ready" })),
      on: vi.fn(() => () => undefined),
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putText: vi.fn() } as never,
    });
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    useTabs.setState({ tabs: [], activeTabId: null });
    useUi.setState({
      createTaskOpen: false,
      composerOpen: false,
      paletteOpen: false,
      quickOpenOpen: false,
    });
    useSessions.setState(useSessions.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("surfaces session load errors with a retry action", () => {
    const load = vi.fn(async () => undefined);
    useSessions.setState({
      sessions: [],
      loading: false,
      error: "offline",
      load,
    });

    render(<HomeTab />);

    expect(screen.queryByText("Sessions unavailable.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry sessions/i }));
    expect(load).toHaveBeenCalledWith(useConnection.getState().api);
  });
});
