// @vitest-environment jsdom

import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHORTCUT_ACTION_IDS } from "@matrix-os/contracts/keyboard-shortcuts";
import {
  handleCloseSelectedAppShortcut,
  handleCloseTopLevelTabShortcut,
  handleMenuNavigate,
  handleNewContextShortcut,
  handleNewAgentRunShortcut,
  handleNewTopLevelTabShortcut,
  runShortcutAction,
  useGlobalShortcuts,
} from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useClosedApps } from "@desktop/renderer/src/stores/closed-apps";
import { useProjectChatLauncher } from "@desktop/renderer/src/lib/project-chat";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { isDesktopSurfaceVisible, useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

describe("handleCloseSelectedAppShortcut", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useClosedApps.setState(useClosedApps.getInitialState(), true);
  });

  it("closes like a click: records the app once for Reopen closed app", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: true });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useTabs.getState().focusTab(terminalId);
    useDesktopSurfaces.getState().activateSurface(terminalId);
    const tracked: string[] = [];
    const onEvent = (event: Event) => tracked.push((event as CustomEvent<{ name: string }>).detail.name);
    window.addEventListener("matrix:desktop-analytics", onEvent);

    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });
    window.removeEventListener("matrix:desktop-analytics", onEvent);

    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([filesId]);
    expect(useClosedApps.getState().entries).toEqual([
      expect.objectContaining({ kind: "terminals", title: "Terminal" }),
    ]);
    expect(tracked).toContain("desktop_app_closed");
    expect(useTabs.getState().activeTabId).toBe(filesId);
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

  it("does not reselect a closed retained app after closing its fallback", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({
      kind: "terminals",
      title: "Terminal",
      closable: true,
    });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useTabs.getState().focusTab(filesId);
    useDesktopSurfaces.getState().activateSurface(filesId);

    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });
    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });

    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("closed");
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([filesId]);
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

  it("does not activate a fallback window hidden by Show Desktop", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().showDesktop();
    useDesktopSurfaces.getState().activateSurface(filesId);
    useTabs.getState().focusTab(filesId);

    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });

    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("closed");
    expect(useDesktopSurfaces.getState().desktopHiddenSurfaceIds).toEqual([terminalId]);
    expect(useTabs.getState().activeTabId).toBeNull();
  });

  it("does not activate a maximized fallback hidden by the Desktop workspace", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().maximizeToTab(terminalId);
    useDesktopSurfaces.getState().activateSurface(filesId);
    useTabs.getState().focusTab(filesId);

    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });

    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("closed");
    expect(useDesktopSurfaces.getState().surfaces[terminalId]?.mode).toBe("tab");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(useTabs.getState().activeTabId).toBeNull();
  });

  it("does not activate a window fallback hidden by the tabs workspace", () => {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: true });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().maximizeToTab(terminalId);
    useTabs.getState().focusTab(terminalId);

    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });
    // The mounted shell reconciles surfaces with the remaining tabs.
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });

    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([filesId]);
    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("window");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(useTabs.getState().activeTabId).toBeNull();
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
    // The mounted shell reconciles surfaces with the remaining tabs.
    useDesktopSurfaces.getState().reconcileTabs([filesId], { width: 1280, height: 720 });

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(filesId);
    expect(useDesktopSurfaces.getState().surfaces[duplicateId!]).toBeUndefined();
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
  });

  it("starts a new chat when Chat is selected and is inert elsewhere", () => {
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
    expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe("window");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");

    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId, filesId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().activateSurface(filesId);
    const tabCount = useTabs.getState().tabs.length;
    handleNewContextShortcut({ preventDefault: vi.fn() });
    expect(newChat).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toHaveLength(tabCount);
  });

  it.each(["conversation", "draft"] as const)(
    "opens a focused floating draft without changing the source %s",
    (chatView) => {
      const sourceId = useTabs.getState().openTabInstance({
        kind: "chat", title: "Retained Chat", chatView,
        ...(chatView === "conversation" ? { chatId: "existing-chat" } : {}),
        closable: true,
      });
      useDesktopSurfaces.getState().reconcileTabs([sourceId], { width: 1280, height: 720 });
      useDesktopSurfaces.getState().setSurfaceBounds(sourceId,
        { x: 60, y: 40, width: 900, height: 600 }, { width: 1280, height: 720 });
      const sourceTab = useTabs.getState().tabs[0];
      const sourceSurface = useDesktopSurfaces.getState().surfaces[sourceId];
      const newChat = vi.fn();
      useHermesChat.setState({ newChat });

      handleNewContextShortcut({ preventDefault: vi.fn() });

      const tabs = useTabs.getState();
      const surfaces = useDesktopSurfaces.getState();
      const draft = tabs.tabs[1]!;
      expect(tabs.tabs[0]).toBe(sourceTab);
      expect(surfaces.surfaces[sourceId]).toEqual(sourceSurface);
      expect(draft).toMatchObject({ kind: "chat", chatView: "draft", closable: true });
      expect(draft.chatId).toBeUndefined();
      expect(draft.id).not.toBe(sourceId);
      expect(tabs.activeTabId).toBe(draft.id);
      expect(surfaces.workspaceView).toBe("desktop");
      expect(surfaces.surfaces[draft.id]).toMatchObject({ mode: "window", restoreMode: "window" });
      expect(surfaces.surfaces[draft.id]!.zIndex).toBeGreaterThan(sourceSurface!.zIndex);
      const bounds = surfaces.surfaces[draft.id]!.bounds;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
      expect(newChat).not.toHaveBeenCalled();
    },
  );

  it("opens a new tab from a maximized Chat without changing its retained route or bounds", () => {
    const sourceId = useTabs.getState().openTab({
      kind: "chat", title: "Retained history", chatId: "existing-chat", closable: false,
    });
    useDesktopSurfaces.getState().reconcileTabs([sourceId], { width: 1280, height: 720 });
    useDesktopSurfaces.getState().maximizeToTab(sourceId);
    const sourceTab = useTabs.getState().tabs[0];
    const sourceSurface = useDesktopSurfaces.getState().surfaces[sourceId];

    handleNewContextShortcut({ preventDefault: vi.fn() });

    const tabs = useTabs.getState();
    const surfaces = useDesktopSurfaces.getState();
    const newId = tabs.tabs[1]!.id;
    expect(tabs.tabs[0]).toBe(sourceTab);
    expect(surfaces.surfaces[sourceId]).toEqual(sourceSurface);
    expect(tabs.activeTabId).toBe(newId);
    expect(tabs.tabs[1]).toMatchObject({ kind: "chat", chatView: "draft" });
    expect(tabs.tabs[1]!.chatId).toBeUndefined();
    expect(surfaces.surfaces[newId]).toMatchObject({ mode: "tab", restoreMode: "tab" });
    expect(surfaces.workspaceView).toBe("tabs");
  });

  it.each(["hidden", "minimized", "closed", "background-window", "background-tab"])(
    "does not create a draft from a %s Chat",
    (visibility) => {
      const sourceId = useTabs.getState().openTab({ kind: "chat", title: "Chat", closable: false });
      useDesktopSurfaces.getState().reconcileTabs([sourceId], { width: 1280, height: 720 });
      const surfaces = useDesktopSurfaces.getState();
      if (visibility === "hidden") surfaces.showDesktop();
      if (visibility === "minimized") surfaces.minimizeSurface(sourceId);
      if (visibility === "closed") surfaces.closeSurface(sourceId);
      if (visibility === "background-window") surfaces.setWorkspaceView("tabs");
      if (visibility === "background-tab") {
        surfaces.maximizeToTab(sourceId);
        surfaces.setWorkspaceView("desktop");
      }
      const beforeTabs = useTabs.getState().tabs;
      const beforeSurfaces = useDesktopSurfaces.getState().surfaces;
      const newChat = vi.fn();
      useHermesChat.setState({ newChat });

      handleNewContextShortcut({ preventDefault: vi.fn() });

      expect(useTabs.getState().tabs).toBe(beforeTabs);
      expect(useDesktopSurfaces.getState().surfaces).toBe(beforeSurfaces);
      expect(newChat).not.toHaveBeenCalled();
    },
  );

});

describe("shortcuts that open or focus an app", () => {
  const VIEWPORT = { width: 1280, height: 720 };

  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    useProjectView.setState({ entries: {}, runtimeScope: null });
    useProjectWorkspaces.setState({ entries: {} });
    useProjectChatLauncher.setState({ composerRequest: null });
    useCodingAgentWorkspace.setState({ summary: null, composerFocusRequestId: 0 });
    vi.stubGlobal("operator", {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reconcile() {
    useDesktopSurfaces.getState().reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), VIEWPORT);
  }

  /** Files is open and selected; `appId` exists in the given state. */
  function withApp(open: () => string, state: "closed" | "minimized" | "behind" | "tabs-view"): string {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const appId = open();
    reconcile();
    const surfaces = useDesktopSurfaces.getState();
    if (state === "closed") surfaces.closeSurface(appId);
    if (state === "minimized") surfaces.minimizeSurface(appId);
    if (state === "tabs-view") surfaces.maximizeToTab(filesId);
    useTabs.getState().focusTab(filesId);
    useDesktopSurfaces.getState().activateSurface(filesId);
    expect(isDesktopSurfaceVisible(appId, useDesktopSurfaces.getState()) && useTabs.getState().activeTabId === appId).toBe(false);
    return appId;
  }

  function expectShownAndActive(appId: string) {
    expect(useTabs.getState().activeTabId).toBe(appId);
    expect(isDesktopSurfaceVisible(appId, useDesktopSurfaces.getState())).toBe(true);
    const surfaces = useDesktopSurfaces.getState().surfaces;
    const topZ = Math.max(...Object.values(surfaces).filter((surface) => surface.mode !== "closed").map((surface) => surface.zIndex));
    if (surfaces[appId]?.mode === "window") expect(surfaces[appId]?.zIndex).toBe(topZ);
  }

  const openTerminal = () => useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });

  it("terminal.focus opens and shows the Terminal when none exists", () => {
    useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    reconcile();

    runShortcutAction("terminal.focus");

    const terminal = useTabs.getState().tabs.find((tab) => tab.kind === "terminals");
    expect(terminal).toBeDefined();
    reconcile();
    expectShownAndActive(terminal!.id);
  });

  it.each(["closed", "minimized", "behind", "tabs-view"] as const)(
    "terminal.focus shows a Terminal that is %s",
    (state) => {
      const terminalId = withApp(openTerminal, state);

      runShortcutAction("terminal.focus");

      expectShownAndActive(terminalId);
      expect(useTabs.getState().tabs.filter((tab) => tab.kind === "terminals")).toHaveLength(1);
    },
  );

  it("chat.open shows a Chat whose window was closed", () => {
    const chatId = withApp(() => useTabs.getState().openTab({ kind: "chat", title: "Chat", closable: false }), "closed");

    runShortcutAction("chat.open");

    expectShownAndActive(chatId);
  });

  it("nav.settings shows Settings whose window was closed", () => {
    const settingsId = withApp(() => useTabs.getState().openTab({ kind: "settings", title: "Settings", closable: false }), "closed");

    runShortcutAction("nav.settings");

    expectShownAndActive(settingsId);
  });

  it("chat.new-thread shows the project's Chat whose window was closed", () => {
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }], activeProjectSlug: "matrix-os" });
    const projectId = withApp(
      () => useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" }),
      "closed",
    );

    runShortcutAction("chat.new-thread");

    expectShownAndActive(projectId);
  });

  it.each(["tabs.new", "tabs.new-context", "app.close", "tabs.close"] as const)(
    "%s acts on the selected visible app, so it leaves a closed app closed",
    (id) => {
      const chatId = withApp(() => useTabs.getState().openTab({ kind: "chat", title: "Chat", closable: false }), "closed");
      useTabs.getState().focusTab(chatId);
      const tabsBefore = useTabs.getState().tabs;

      runShortcutAction(id);

      expect(useTabs.getState().tabs).toBe(tabsBefore);
      expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe("closed");
    },
  );
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

describe("runShortcutAction", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let listeners: Map<string, (payload: unknown) => void>;

  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    useClosedApps.setState(useClosedApps.getInitialState(), true);
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    listeners = new Map();
    invoke = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("operator", {
      invoke,
      on: (channel: string, callback: (payload: unknown) => void) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openTwoWindows(): [string, string] {
    const filesId = useTabs.getState().openTab({ kind: "files", title: "Files", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([filesId, terminalId], { width: 1280, height: 720 });
    useTabs.getState().focusTab(filesId);
    useDesktopSurfaces.getState().activateSurface(filesId);
    return [filesId, terminalId];
  }

  it.each(SHORTCUT_ACTION_IDS)("runs %s against fresh stores", (id) => {
    expect(() => runShortcutAction(id)).not.toThrow();
  });

  it("toggles the App Launcher like the taskbar button, analytics included", () => {
    const tracked: Array<{ name: string; open?: boolean }> = [];
    const onEvent = (event: Event) => tracked.push((event as CustomEvent<{ name: string; open?: boolean }>).detail);
    window.addEventListener("matrix:desktop-analytics", onEvent);

    runShortcutAction("app.launcher");
    expect(useUi.getState().appLauncherOpen).toBe(true);
    expect(tracked).toEqual([{ name: "desktop_launcher_toggled", open: true }]);
    runShortcutAction("app.launcher");
    window.removeEventListener("matrix:desktop-analytics", onEvent);

    expect(useUi.getState().appLauncherOpen).toBe(false);
    expect(tracked).toHaveLength(2);
  });

  it("opens the Terminal window through main", () => {
    runShortcutAction("terminal.window");
    expect(invoke).toHaveBeenCalledWith("terminal-window:open", {});
  });

  it("opens Settings", () => {
    runShortcutAction("nav.settings");
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)?.kind).toBe("settings");
  });

  it("dispatches shortcut:action events from main", () => {
    const [, terminalId] = openTwoWindows();
    const { unmount } = renderHook(() => useGlobalShortcuts());

    listeners.get("shortcut:action")?.({ id: "app.next" });

    expect(useTabs.getState().activeTabId).toBe(terminalId);
    unmount();
    expect(listeners.has("shortcut:action")).toBe(false);
  });

  it("no longer handles shortcut keys in the page: main dispatches them", () => {
    const [filesId] = openTwoWindows();
    renderHook(() => useGlobalShortcuts());

    fireEvent.keyDown(window, { key: "q", code: "KeyQ", metaKey: true });
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });

    expect(useDesktopSurfaces.getState().surfaces[filesId]?.mode).toBe("window");
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("listens only for shortcut:action", () => {
    renderHook(() => useGlobalShortcuts());

    expect([...listeners.keys()]).toEqual(["shortcut:action"]);
  });
});
