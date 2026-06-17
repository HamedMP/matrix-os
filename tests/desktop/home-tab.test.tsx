// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeTab from "../../desktop/src/renderer/src/features/mission-control/HomeTab";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("HomeTab", () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn(async () => ({ embedId: "embed-test", state: "ready" }));
    vi.stubGlobal("operator", {
      invoke,
      on: vi.fn(() => () => undefined),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class FakeResizeObserver {
        observe(): void {}
        disconnect(): void {}
      },
    );
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

  it("opens the hosted shell embed", async () => {
    render(<HomeTab />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "embed:open",
        expect.objectContaining({ kind: "hosted-shell" }),
      );
    });
  });

  it("does not open the hosted shell embed before sign-in is confirmed", () => {
    useConnection.setState({
      status: "loading",
      handle: null,
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });

    render(<HomeTab />);

    expect(invoke).not.toHaveBeenCalledWith(
      "embed:open",
      expect.objectContaining({ kind: "hosted-shell" }),
    );
  });
});
