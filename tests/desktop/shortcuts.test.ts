import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCycleTabShortcut,
  handleCloseTabShortcut,
  handleMenuNavigate,
} from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

describe("handleCloseTabShortcut", () => {
  it("prevents the native window close even when the active tab is not closable", () => {
    const preventDefault = vi.fn();
    const closeTab = vi.fn();

    handleCloseTabShortcut(
      { preventDefault },
      {
        activeTabId: "home",
        tabs: [{ id: "home", closable: false }],
        closeTab,
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("prevents default and closes the active tab when it is closable", () => {
    const preventDefault = vi.fn();
    const closeTab = vi.fn();

    handleCloseTabShortcut(
      { preventDefault },
      {
        activeTabId: "task",
        tabs: [{ id: "task", closable: true }],
        closeTab,
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith("task");
  });
});

describe("handleCycleTabShortcut", () => {
  it("focuses the first tab on forward cycle when no tab is active", () => {
    const preventDefault = vi.fn();
    const focusTab = vi.fn();

    handleCycleTabShortcut(
      { preventDefault },
      {
        activeTabId: null,
        tabs: [{ id: "one" }, { id: "two" }],
        focusTab,
      },
      1,
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusTab).toHaveBeenCalledWith("one");
  });

  it("focuses the last tab on reverse cycle when no tab is active", () => {
    const preventDefault = vi.fn();
    const focusTab = vi.fn();

    handleCycleTabShortcut(
      { preventDefault },
      {
        activeTabId: null,
        tabs: [{ id: "one" }, { id: "two" }],
        focusTab,
      },
      -1,
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusTab).toHaveBeenCalledWith("two");
  });
});

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

  it("opens the coding-agent workspace from menu navigation", () => {
    handleMenuNavigate("agents");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "agents",
      title: "Agents",
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

  it("falls back to home without warning when board navigation has no project", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    handleMenuNavigate("board");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "home",
      title: "Home",
      closable: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
