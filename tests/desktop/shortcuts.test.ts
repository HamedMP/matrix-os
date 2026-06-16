import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMenuNavigate } from "../../desktop/src/renderer/src/features/mission-control/shortcuts";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("handleMenuNavigate", () => {
  beforeEach(() => {
    useBoard.setState({
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    vi.restoreAllMocks();
  });

  it("opens board tabs for active projects", () => {
    useBoard.setState({
      projects: [{ slug: "matrix", name: "Matrix OS" }],
      activeProjectSlug: "matrix",
    });

    handleMenuNavigate("board");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "board",
      projectSlug: "matrix",
      title: "Matrix OS",
    });
  });

  it("falls back to home and logs unsupported menu kinds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    handleMenuNavigate("apps");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "home",
      title: "Home",
      closable: false,
    });
    expect(warn).toHaveBeenCalledWith("[shortcuts] unsupported menu:navigate kind: apps");
  });
});
