// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  default: () => null,
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
    useTabs.getState().recordRecentConversation("thread-1", "Fix navigation");
    useUi.setState({ sidebarCollapsed: false, requestedSettingsSection: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderSidebar() {
    return render(<Tooltip.Provider><Sidebar /></Tooltip.Provider>);
  }

  it("filters bounded Recents by conversation, terminal, and project type", () => {
    renderSidebar();

    expect(screen.getByText("Fix navigation")).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Fix navigation" }).querySelector(".lucide-message-circle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent dev" }).querySelector(".lucide-square-terminal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open recent Matrix OS" }).querySelector(".lucide-folder-kanban")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Filter recents" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminals" }));

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
    useTabs.getState().recordRecentConversation("conversation-two", "Trip planning");
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Open recent Trip planning" }));

    expect(openConversation).toHaveBeenCalledWith(
      useConnection.getState().api,
      "conversation-two",
    );
    expect(useThreads.getState().activeThreadId).toBeNull();
  });

  it("uses the global Chat navigation to return to the canonical inbox", () => {
    useHermesChat.setState({ view: "conversation", sessionId: "conversation-two" });
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(useHermesChat.getState().view).toBe("index");
    expect(useThreads.getState().activeThreadId).toBeNull();
    expect(useTabs.getState().recentViews.some((recent) => recent.id === "hermes"))
      .toBe(false);
  });

  it("offers the approved account actions and routes them through current behavior", () => {
    renderSidebar();
    const trigger = screen.getByRole("button", { name: "Open account menu" });

    fireEvent.click(trigger);
    expect(screen.getByText("ada operator", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)).toMatchObject({ kind: "settings" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "View all plans" }));
    expect(useUi.getState().requestedSettingsSection).toBe("billing");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(invoke).toHaveBeenCalledWith("shell:open-external", { url: "https://matrix-os.com/docs" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});
