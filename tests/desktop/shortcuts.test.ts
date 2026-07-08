import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCycleTabShortcut,
  handleCloseTabShortcut,
  handleMenuNavigate,
  handleTerminalFocusShortcut,
  isTerminalFocusShortcut,
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

describe("handleTerminalFocusShortcut", () => {
  it("matches only the exact terminal focus modifier chord", () => {
    expect(isTerminalFocusShortcut({
      altKey: true,
      ctrlKey: false,
      key: "t",
      metaKey: true,
      shiftKey: false,
    })).toBe(true);
    expect(isTerminalFocusShortcut({
      altKey: true,
      ctrlKey: false,
      key: "t",
      metaKey: true,
      shiftKey: true,
    })).toBe(false);
  });

  it("prevents default and focuses an existing terminal tab", () => {
    const preventDefault = vi.fn();
    const focusTab = vi.fn();
    const openTab = vi.fn();

    handleTerminalFocusShortcut(
      { preventDefault },
      {
        tabs: [
          { id: "home", kind: "home" },
          { id: "term", kind: "terminal" },
        ],
        focusTab,
        openTab,
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusTab).toHaveBeenCalledWith("term");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("opens the terminal workspace when no terminal tab exists", () => {
    const preventDefault = vi.fn();
    const focusTab = vi.fn();
    const openTab = vi.fn();

    handleTerminalFocusShortcut(
      { preventDefault },
      {
        tabs: [{ id: "home", kind: "home" }],
        focusTab,
        openTab,
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusTab).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith({ kind: "terminals", title: "Terminal" });
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

  it("focuses an existing terminal tab from menu navigation", () => {
    const terminalId = useTabs.getState().openTab({ kind: "terminal", sessionName: "matrix-main", title: "matrix-main" });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });

    handleMenuNavigate("terminals");

    expect(useTabs.getState().activeTabId).toBe(terminalId);
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
