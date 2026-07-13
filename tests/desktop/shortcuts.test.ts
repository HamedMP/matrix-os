import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCycleTabShortcut,
  handleCloseTabShortcut,
  handleAgentWorkspaceShortcut,
  handleMenuNavigate,
  handleNewAgentRunShortcut,
  handleTerminalFocusShortcut,
  isAgentWorkspaceShortcut,
  isTerminalFocusShortcut,
} from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

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

describe("handleNewAgentRunShortcut", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({
      summary: null,
      composerFocusRequestId: 0,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    useUi.setState({
      composerOpen: false,
      paletteOpen: false,
    });
  });

  it("routes desktop new-run shortcuts to the coding-agent workspace composer", () => {
    const preventDefault = vi.fn();
    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useTabs.getState(),
      useCodingAgentWorkspace.getState(),
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId + 1);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("focuses the existing Agents workspace tab on repeated new-run shortcuts", () => {
    const preventDefault = vi.fn();

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useTabs.getState(),
      useCodingAgentWorkspace.getState(),
    );
    const firstTabId = useTabs.getState().activeTabId;
    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useTabs.getState(),
      useCodingAgentWorkspace.getState(),
    );

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(firstTabId);
  });

  it("keeps the legacy composer open when desktop workspace routing is disabled", () => {
    const preventDefault = vi.fn();
    useUi.setState({ composerOpen: true });

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useTabs.getState(),
      useCodingAgentWorkspace.getState(),
      { desktopWorkspaceEnabled: false },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useUi.getState().composerOpen).toBe(true);
    expect(useTabs.getState().tabs).toEqual([]);
  });
});

describe("handleAgentWorkspaceShortcut", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({
      summary: null,
      composerFocusRequestId: 0,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  it("matches only the exact Agents workspace modifier chord", () => {
    expect(isAgentWorkspaceShortcut({
      altKey: true,
      ctrlKey: false,
      key: "a",
      metaKey: true,
      shiftKey: false,
    })).toBe(true);
    expect(isAgentWorkspaceShortcut({
      altKey: true,
      ctrlKey: false,
      key: "a",
      metaKey: true,
      shiftKey: true,
    })).toBe(false);
  });

  it("opens the Agents workspace without requesting composer focus", () => {
    const preventDefault = vi.fn();
    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;

    handleAgentWorkspaceShortcut({ preventDefault }, useTabs.getState());

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "agents",
      slug: "agents",
      title: "Agents",
    });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId);
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
      slug: "agents",
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
