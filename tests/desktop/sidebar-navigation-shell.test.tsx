// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

vi.mock("../../desktop/src/renderer/src/features/runtime/RuntimeComputerMenu", () => ({
  default: () => <button type="button">Main computer</button>,
}));

const invoke = vi.fn(async () => ({ ok: true }));
const signOut = vi.fn(async () => undefined);
const openConversation = vi.fn(async () => true);

describe("Desktop sidebar navigation shell", () => {
  beforeEach(() => {
    window.operator = { invoke, on: vi.fn(() => () => undefined) };
    invoke.mockClear();
    signOut.mockClear();
    openConversation.mockClear();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: "Ada Operator",
      imageUrl: null,
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      authGeneration: 7,
      api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
      signOut,
    });
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useHermesChat.setState({ openConversation });
    useBoard.setState({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    useCodingAgentWorkspace.setState({ summary: null, activeThreadId: null, reviews: null });
    useThreads.setState({
      threads: [{
        id: "thread-1",
        requestId: "request-1",
        sessionId: null,
        taskId: null,
        title: "Fix navigation",
        status: "done",
        transcript: [],
        unread: false,
        createdAt: 1,
        updatedAt: 2,
      }],
      activeThreadId: null,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    useTabs.getState().openTab({ kind: "project", projectSlug: "matrix-os", title: "Matrix OS" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    useTabs.setState((state) => ({
      recentViews: [{
        kind: "conversation",
        id: "thread-1",
        label: "Fix navigation",
        visitedAt: Date.now(),
      }, ...state.recentViews],
    }));
    useTabs.getState().recordRecentTerminal("dev", "dev");
    useTabs.getState().recordRecentProject("matrix-os", "Matrix OS");
    useUi.setState({ sidebarCollapsed: false, requestedSettingsSection: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderSidebar() {
    return render(<Tooltip.Provider><Sidebar /></Tooltip.Provider>);
  }

  it("filters bounded Recents by conversation, terminal, and project type", async () => {
    renderSidebar();

    expect(screen.getByText("Fix navigation")).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Fix navigation" }).querySelector(".lucide-message-circle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent dev" }).querySelector(".lucide-square-terminal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Matrix OS" }).querySelector(".lucide-folder-kanban")).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter recents" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Terminals" }));

    expect(screen.queryByText("Fix navigation")).toBeNull();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open recent Matrix OS" })).toBeNull();
  });

  it("focuses the existing canonical Terminal tab from Recents without duplication", () => {
    const terminal = useTabs.getState().tabs.find((tab) => tab.kind === "terminal");
    expect(terminal).toBeTruthy();
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const mountedTabs = useTabs.getState().tabs;
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent dev" }));

    expect(useTabs.getState().activeTabId).toBe(terminal?.id);
    expect(useTabs.getState().tabs).toBe(mountedTabs);
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "terminal" && tab.sessionName === "dev")).toHaveLength(1);
  });

  it("routes a Terminal recent without a native tab through the mounted Terminal workspace", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    const terminalsWorkspace = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().recordRecentTerminal("matrix-main", "matrix-main");
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent matrix-main" }));

    expect(useTabs.getState().activeTabId).toBe(terminalsWorkspace);
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "terminal")).toHaveLength(0);
  });

  it("routes a Terminal recent through the mounted workspace when a native tab also exists", () => {
    const terminalsWorkspace = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent dev" }));

    expect(useTabs.getState().activeTabId).toBe(terminalsWorkspace);
    expect(useTabs.getState().terminalSessionRequest).toMatchObject({ sessionName: "dev" });
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "terminal" && tab.sessionName === "dev")).toHaveLength(1);
  });

  it("opens a recent conversation in Chat and restores its selection", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent Fix navigation" }));

    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)).toMatchObject({ kind: "chat" });
    expect(useThreads.getState().activeThreadId).toBe("thread-1");
  });

  it("opens a canonical Hermes recent through the Gateway-backed loader", () => {
    useTabs.getState().recordRecentHermesConversation("conversation-two", "Trip planning");
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent Trip planning" }));

    expect(openConversation).toHaveBeenCalledWith(
      useConnection.getState().api,
      "conversation-two",
    );
    expect(useThreads.getState().activeThreadId).toBeNull();
  });

  it("marks only the active conversation type current when retained identifiers coexist", () => {
    useTabs.getState().recordRecentHermesConversation("conversation-two", "Trip planning");
    useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
    useThreads.setState({ activeThreadId: "thread-1" });
    useHermesChat.setState({ view: "conversation", sessionId: "conversation-two" });

    renderSidebar();

    expect(screen.getByRole("button", { name: "Open recent Fix navigation" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Open recent Trip planning" }).getAttribute("aria-current")).toBeNull();
  });

  it("uses the global Chat navigation to return to the canonical inbox", () => {
    useHermesChat.setState({ view: "conversation", sessionId: "conversation-two" });
    useTabs.getState().openTab({
      kind: "chat",
      title: "Selected canonical Chat",
      chatId: "chat_canonical_selected",
      closable: false,
    });
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(useHermesChat.getState().view).toBe("index");
    expect(useThreads.getState().activeThreadId).toBeNull();
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId))
      .toMatchObject({ kind: "chat", title: "Chat", chatId: undefined });
    expect(useTabs.getState().recentViews.some((recent) => recent.id === "hermes"))
      .toBe(false);
  });

  it("uses the global Terminal navigation to open the Terminal list root", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    const activeTab = useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    );
    expect(activeTab).toMatchObject({ kind: "terminals", title: "Terminal" });
    expect(useTabs.getState().terminalSessionRequest).toMatchObject({ sessionName: null });
  });

  it("matches the Figma navigation hierarchy and keeps the sidebar borderless", () => {
    useBoard.setState({
      projects: [{ slug: "matrix-os", name: "Matrix OS", kind: "scratch" }],
    });
    renderSidebar();

    const sidebar = screen.getByRole("complementary", { name: "Matrix OS navigation" });
    expect(sidebar.getAttribute("data-sidebar-state")).toBe("expanded");
    expect(sidebar.style.width).toBe("var(--sidebar-expanded-width)");
    expect(sidebar.style.borderRight).toBe("");
    expect(screen.queryByTestId("matrix-sidebar-logo")).toBeNull();

    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBeNull();

    const dividers = screen.getAllByRole("separator");
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) {
      expect(divider.style.marginInline).toBe("16px");
      expect(divider.style.background).toBe("var(--sidebar-divider)");
    }

    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(terminal.style.background).toBe("var(--bg-surface)");
    expect(terminal.style.boxShadow).toBe("inset 0 0 0 1px var(--border-subtle)");
    expect(terminal.style.borderWidth).toBe("");
    expect(terminal.style.fontWeight).toBe("500");

    const figmaGlyphs = {
      Home: ".lucide-house",
      Chat: ".lucide-message-circle",
      Terminal: ".lucide-terminal",
      Files: ".lucide-file",
      Apps: ".lucide-layout-grid",
      Projects: ".lucide-folder-open",
    } as const;
    for (const [label, selector] of Object.entries(figmaGlyphs)) {
      expect(screen.getByRole("button", { name: label }).querySelector(selector)).toBeTruthy();
    }
    const pluginsGlyph = screen.getByRole("button", { name: "Plugins" })
      .querySelector<HTMLElement>('[data-figma-icon="phosphor-plugs"]');
    expect(pluginsGlyph).toBeTruthy();
    expect(pluginsGlyph?.style.maskImage).toContain("plugs.svg");
    expect(pluginsGlyph?.style.maskRepeat).toBe("no-repeat");

    for (const label of ["Home", "Chat", "Terminal", "Files", "Apps", "Plugins", "Projects"]) {
      const icon = screen.getByRole("button", { name: label }).querySelector<HTMLElement>("[data-sidebar-icon]");
      expect(icon?.style.width).toBe("14px");
      expect(icon?.style.height).toBe("14px");
    }

    const orderedLabels = [
      "Main computer",
      "Home",
      "Chat",
      "Terminal",
      "Files",
      "Apps",
      "Plugins",
      "Projects",
      "Filter recents",
      "Open account menu",
    ];
    const orderedButtons = orderedLabels.map((label) => screen.getByRole("button", { name: label }));
    for (let index = 1; index < orderedButtons.length; index += 1) {
      expect(orderedButtons[index - 1]!.compareDocumentPosition(orderedButtons[index]!))
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }

    const projects = screen.getByRole("button", { name: "Projects" });
    fireEvent.click(projects);
    expect(projects.getAttribute("aria-current")).toBe("page");
    expect(useTabs.getState().tabs.find((tab) => tab.kind === "projects")).toBeTruthy();
  });

  it("opens and focuses one canonical Projects index tab", () => {
    renderSidebar();

    const projects = screen.getByRole("button", { name: "Projects" });
    fireEvent.click(projects);

    const first = useTabs.getState().tabs.find((tab) => tab.kind === "projects");
    expect(first).toBeTruthy();
    expect(useTabs.getState().activeTabId).toBe(first?.id);
    expect(projects.getAttribute("aria-current")).toBe("page");

    fireEvent.click(projects);
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "projects")).toHaveLength(1);
    expect(useTabs.getState().activeTabId).toBe(first?.id);
  });

  it("does not reopen a Project detail after using the global Projects navigation", () => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    const home = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    )).toMatchObject({ kind: "projects" });

    act(() => useTabs.getState().goBack());
    expect(useTabs.getState().activeTabId).toBe(home);
    expect(useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    )).toMatchObject({ kind: "home" });
  });

  it("removes the navigation column below the title bar when collapsed", () => {
    useUi.setState({ sidebarCollapsed: true });
    const { container } = renderSidebar();

    const sidebar = container.querySelector("aside")!;
    expect(sidebar).not.toBeNull();
    expect(sidebar.getAttribute("data-sidebar-state")).toBe("collapsed");
    expect(sidebar.style.width).toBe("var(--sidebar-collapsed-width)");
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByTestId("matrix-sidebar-logo")).toBeNull();
    expect(screen.queryByText("Recents")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open account menu" })).toBeNull();
  });

  it("opens Recents and account menus from the keyboard", async () => {
    renderSidebar();

    const recentsTrigger = screen.getByRole("button", { name: "Filter recents" });
    fireEvent.keyDown(recentsTrigger, { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Recent type" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });

    const accountTrigger = screen.getByRole("button", { name: "Open account menu" });
    fireEvent.keyDown(accountTrigger, { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Account" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  });

  it("offers the approved account actions and routes them through current behavior", async () => {
    renderSidebar();
    const trigger = screen.getByRole("button", { name: "Open account menu" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByText("ada operator", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)).toMatchObject({ kind: "settings" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "View all plans" }));
    expect(useUi.getState().requestedSettingsSection).toBe("billing");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Get help" }));
    expect(invoke).toHaveBeenCalledWith("shell:open-external", { url: "https://matrix-os.com/docs" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});
