// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCycleTabShortcut,
  handleCloseTabShortcut,
  handleMenuNavigate,
  handleNewAgentRunShortcut,
  handleTerminalFocusShortcut,
  isTerminalFocusShortcut,
} from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useProjectChatLauncher } from "@desktop/renderer/src/lib/project-chat";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
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
    useBoard.setState({ projects: [], activeProjectSlug: null });
    useProjectView.setState({ entries: {}, runtimeScope: null });
    useProjectWorkspaces.setState({ entries: {} });
    useProjectChatLauncher.setState({ composerRequest: null });
    useUi.setState({
      composerOpen: false,
      paletteOpen: false,
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
  });

  it("routes new-run shortcuts to the active board project's chats view", () => {
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS" }],
      activeProjectSlug: "matrix-os",
    });
    const preventDefault = vi.fn();
    const focusRequestId = useCodingAgentWorkspace.getState().composerFocusRequestId;

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useCodingAgentWorkspace.getState(),
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectChatLauncher.getState().composerRequest).toMatchObject({ projectId: "matrix-os" });
    expect(useCodingAgentWorkspace.getState().composerFocusRequestId).toBe(focusRequestId + 1);
    expect(useUi.getState().composerOpen).toBe(false);
  });

  it("targets the open project tab over the board's active project", () => {
    useBoard.setState({
      projects: [
        { slug: "matrix-os", name: "Matrix OS" },
        { slug: "website", name: "Website" },
      ],
      activeProjectSlug: "website",
    });
    useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });

    handleNewAgentRunShortcut(
      { preventDefault: vi.fn() },
      useUi.getState(),
      useCodingAgentWorkspace.getState(),
    );

    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "project")).toHaveLength(1);
    expect(useProjectChatLauncher.getState().composerRequest).toMatchObject({ projectId: "matrix-os" });
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().viewFor("website")).toBe("board");
  });

  it("keeps the legacy composer open when desktop workspace routing is disabled", () => {
    const preventDefault = vi.fn();
    useUi.setState({ composerOpen: true });

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useCodingAgentWorkspace.getState(),
      { desktopWorkspaceEnabled: false },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useUi.getState().composerOpen).toBe(true);
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("opens the legacy composer when the runtime has no projects", () => {
    const preventDefault = vi.fn();

    handleNewAgentRunShortcut(
      { preventDefault },
      useUi.getState(),
      useCodingAgentWorkspace.getState(),
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(useUi.getState().composerOpen).toBe(true);
    expect(useTabs.getState().tabs).toEqual([]);
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

  it("opens project tabs for active projects", () => {
    useBoard.setState({
      projects: [{ slug: "matrix", name: "Matrix OS" }],
      activeProjectSlug: "matrix",
    });

    handleMenuNavigate("board");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "project",
      projectSlug: "matrix",
      title: "Matrix OS",
    });
  });

  it("treats the retired agents kind as unsupported and falls back home", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    handleMenuNavigate("agents");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "home",
      title: "Home",
      closable: false,
    });
    expect(warn).toHaveBeenCalledWith("[shortcuts] unsupported menu:navigate kind: agents");
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
