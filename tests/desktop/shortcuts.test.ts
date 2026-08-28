// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCloseSelectedAppShortcut,
  handleCloseTopLevelTabShortcut,
  handleCycleTabShortcut,
  handleMenuNavigate,
  handleNewContextShortcut,
  handleNewAgentRunShortcut,
  handleNewTopLevelTabShortcut,
  handleTerminalFocusShortcut,
  isTerminalFocusShortcut,
} from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useProjectChatLauncher } from "@desktop/renderer/src/lib/project-chat";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

describe("handleCloseSelectedAppShortcut", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  });

  it("closes the selected Matrix app surface and focuses the topmost remaining app", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useTabs.getState().focusTab(filesId);
    useDesktopSurfaces.getState().activateSurface(filesId);
    const preventDefault = vi.fn();

    handleCloseSelectedAppShortcut({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("closed");
    expect(useTabs.getState().activeTabId).toBe(terminalId);
    expect(useDesktopSurfaces.getState().surfaces[terminalId]?.mode).toBe("window");
  });

  it("clears the selected tab when closing the only non-closable app surface", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });
    const preventDefault = vi.fn();

    handleCloseSelectedAppShortcut({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("closed");
    expect(useTabs.getState().activeTabId).toBeNull();
  });

  it("suppresses the native shortcut without closing a hidden selected app", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().showDesktop();
    const preventDefault = vi.fn();

    handleCloseSelectedAppShortcut({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("window");
  });

  it("does not close a maximized tab after returning to the Desktop workspace", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().maximizeToTab(filesId);
    useDesktopSurfaces.getState().setWorkspaceView("desktop");
    const preventDefault = vi.fn();

    handleCloseSelectedAppShortcut({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("tab");
  });
});

describe("top-level app tab shortcuts", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  });

  it("opens a new top-level Terminal tab without requesting a shell session", () => {
    const terminalId = useTabs.getState().openTab({
      kind: "terminals",
      title: "Terminal",
      closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([terminalId], { width: 1280, height: 720 });
    const preventDefault = vi.fn();

    expect(handleNewTopLevelTabShortcut({ preventDefault })).toBe(true);

    const state = useTabs.getState();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.map((tab) => tab.kind)).toEqual(["terminals", "terminals"]);
    expect(state.tabs[1]).toMatchObject({ title: "Terminal", closable: true });
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(state.terminalSessionRequest).toBeNull();
    expect(useDesktopSurfaces.getState()).toMatchObject({ workspaceView: "tabs" });
    expect(Object.values(useDesktopSurfaces.getState().surfaces).map((surface) => surface.mode))
      .toEqual(["tab", "tab"]);
  });

  it("opens a new top-level Chat tab", () => {
    const chatId = useTabs.getState().openTab({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([chatId], { width: 1280, height: 720 });
    const preventDefault = vi.fn();

    expect(handleNewTopLevelTabShortcut({ preventDefault })).toBe(true);

    const state = useTabs.getState();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.map((tab) => tab.kind)).toEqual(["work", "chat"]);
    expect(state.tabs[1]).toMatchObject({
      title: "Chat",
      chatView: "draft",
      closable: true,
    });
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(useDesktopSurfaces.getState()).toMatchObject({ workspaceView: "tabs" });
    expect(Object.values(useDesktopSurfaces.getState().surfaces).map((surface) => surface.mode))
      .toEqual(["tab", "tab"]);
  });

  it("opens and closes a fresh top-level Files tab without changing folder tabs", () => {
    const filesId = useTabs.getState().openTab({
      kind: "files",
      title: "Files",
      slug: "files",
      closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });

    expect(handleNewTopLevelTabShortcut({ preventDefault: vi.fn() })).toBe(true);
    const duplicateId = useTabs.getState().activeTabId;
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(duplicateId).not.toBe(filesId);

    handleCloseTopLevelTabShortcut({ preventDefault: vi.fn() });

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(filesId);
    expect(useDesktopSurfaces.getState().surfaces[duplicateId!]?.mode).toBe("closed");
  });

  it("does not invent a new top-level tab for unsupported apps", () => {
    const settingsId = useTabs.getState().openTab({
      kind: "settings",
      title: "Settings",
      closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([settingsId], { width: 1280, height: 720 });

    expect(handleNewTopLevelTabShortcut({ preventDefault: vi.fn() })).toBe(false);
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it("evicts the matching desktop surface when the top-level tab limit is reached", () => {
    const filesId = useTabs.getState().openTab({
      kind: "files",
      title: "Files",
      slug: "files",
      closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });

    for (let index = 0; index < 30; index += 1) {
      expect(handleNewTopLevelTabShortcut({ preventDefault: vi.fn() })).toBe(true);
    }

    const retainedTabIds = new Set(useTabs.getState().tabs.map((tab) => tab.id));
    const surfaceIds = Object.keys(useDesktopSurfaces.getState().surfaces);
    expect(useTabs.getState().tabs).toHaveLength(24);
    expect(surfaceIds).toHaveLength(24);
    expect(surfaceIds.every((tabId) => retainedTabIds.has(tabId))).toBe(true);
  });
});

describe("handleNewContextShortcut", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useUi.setState({ createTaskOpen: false });
  });

  it("starts a new chat when Chat is selected and keeps New Task elsewhere", () => {
    const newChat = vi.fn();
    useHermesChat.setState({ newChat });
    const chatId = useTabs.getState().openTab({ kind: "chat", title: "Existing chat", chatId: "chat-1", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId], { width: 1280, height: 720 });
    const preventDefault = vi.fn();

    handleNewContextShortcut({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(newChat).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "work",
      title: "Chat",
      chatId: "chat-1",
      chatTitle: "Existing chat",
      workRoute: "chat",
    });
    expect(useTabs.getState().tabs[1]).toMatchObject({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: true,
    });
    expect(useTabs.getState().tabs[1]?.chatId).toBeUndefined();
    expect(useUi.getState().createTaskOpen).toBe(false);

    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId, filesId], { width: 1280, height: 720 });
    handleNewContextShortcut({ preventDefault: vi.fn() });
    expect(newChat).not.toHaveBeenCalled();
    expect(useUi.getState().createTaskOpen).toBe(true);
  });

  it("does not create a chat for a hidden Chat surface", () => {
    const newChat = vi.fn();
    useHermesChat.setState({ newChat });
    const chatId = useTabs.getState().openTab({ kind: "chat", title: "Chat", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().showDesktop();

    handleNewContextShortcut({ preventDefault: vi.fn() });

    expect(newChat).not.toHaveBeenCalled();
    expect(useUi.getState().createTaskOpen).toBe(false);
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
      kind: "work",
      workRoute: "project",
      projectSlug: "matrix-os",
      title: "Chat",
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

    expect(useTabs.getState().tabs.filter((tab) => (
      tab.kind === "work" && tab.workRoute === "project"
    ))).toHaveLength(1);
    expect(useProjectChatLauncher.getState().composerRequest).toMatchObject({ projectId: "matrix-os" });
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().viewFor("website")).toBe("overview");
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
      kind: "work",
      workRoute: "project",
      projectSlug: "matrix",
      title: "Chat",
    });
  });

  it("treats the retired agents kind as unsupported and falls back home", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    handleMenuNavigate("agents");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "home",
      title: "Browser",
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
      title: "Browser",
      closable: false,
    });
    expect(warn).toHaveBeenCalledWith("[shortcuts] unsupported menu:navigate kind: apps");
  });

  it("falls back to home without warning when board navigation has no project", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    handleMenuNavigate("board");

    expect(useTabs.getState().tabs[0]).toMatchObject({
      kind: "home",
      title: "Browser",
      closable: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
