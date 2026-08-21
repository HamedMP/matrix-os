// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NavigationHeader, {
  breadcrumbItemsForTab,
  breadcrumbsForTab,
} from "../../desktop/src/renderer/src/features/mission-control/NavigationHeader";
import ChatTab from "../../desktop/src/renderer/src/features/chat/ChatTab";
import { useTabs, type Tab } from "../../desktop/src/renderer/src/stores/tabs";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("Desktop navigation header", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    useUi.setState(useUi.getInitialState(), true);
    useThreads.setState(useThreads.getInitialState(), true);
    useHermesChat.setState(useHermesChat.getInitialState(), true);
  });

  afterEach(() => cleanup());

  it("builds contextual root and nested breadcrumbs", () => {
    const project: Tab = {
      id: "project",
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
      closable: true,
    };
    const task: Tab = {
      id: "task",
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-301",
      title: "Desktop navigation",
      closable: true,
    };

    expect(breadcrumbsForTab({ ...project, kind: "home", title: "Home" })).toEqual(["Home"]);
    expect(breadcrumbsForTab(project)).toEqual(["Home", "Projects", "Matrix OS"]);
    expect(breadcrumbsForTab(task)).toEqual(["Home", "Projects", "matrix-os", "Desktop navigation"]);
  });

  it("uses stable semantic paths for breadcrumb identity", () => {
    const project: Tab = {
      id: "project",
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
      closable: true,
    };
    const task: Tab = {
      id: "task",
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-301",
      title: "Desktop navigation",
      closable: true,
    };

    expect(breadcrumbItemsForTab(project)).toEqual([
      { key: "home", label: "Home" },
      { key: "projects", label: "Projects" },
      { key: "projects/matrix-os", label: "Matrix OS" },
    ]);
    expect(breadcrumbItemsForTab(task)).toEqual([
      { key: "home", label: "Home" },
      { key: "projects", label: "Projects" },
      { key: "projects/matrix-os", label: "matrix-os" },
      { key: "projects/matrix-os/tasks/MAT-301", label: "Desktop navigation" },
    ]);
    expect(breadcrumbItemsForTab({ ...task, title: "Renamed navigation" }).map((item) => item.key))
      .toEqual(breadcrumbItemsForTab(task).map((item) => item.key));
  });

  it("drives Back and Forward while keeping the cached tabs present", () => {
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const app = useTabs.getState().openTab({ kind: "app", slug: "dev", title: "dev" });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.getByRole("button", { name: "Go forward" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(useTabs.getState().activeTabId).toBe(home);
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home, app]);
    expect(screen.getByText("Home")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));
    expect(useTabs.getState().activeTabId).toBe(app);
    expect(screen.getByText("dev")).toBeTruthy();
  });

  it("returns from a selected Chat conversation to the Chat list before older history", () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
    useHermesChat.setState({
      sessionId: "conversation-two",
      view: "conversation",
      conversations: [{
        id: "conversation-two",
        title: "Trip planning",
        preview: "Plan a trip",
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    render(
      <Tooltip.Provider>
        <NavigationHeader />
        <ChatTab />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("region", { name: "Hermes conversation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Chat");
  });

  it("uses the Chat breadcrumb root to return to the Chat list", () => {
    useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
    useHermesChat.setState({
      sessionId: "conversation-two",
      view: "conversation",
      conversations: [{
        id: "conversation-two",
        title: "Trip planning",
        preview: "Plan a trip",
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    render(
      <Tooltip.Provider>
        <NavigationHeader />
        <ChatTab />
      </Tooltip.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Chat");
  });

  it("returns from a directly opened Project to the Projects list before older history", () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("HomeProjects");
  });

  it("returns from a directly opened Project task to the Projects list before older history", () => {
    const homeTabId = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("HomeProjects");

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(useTabs.getState().activeTabId).toBe(homeTabId);
  });

  it("returns through an existing Projects root without looping back to a task", () => {
    const homeTabId = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    const projectsTabId = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    useTabs.getState().openTab({
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(useTabs.getState()).toMatchObject({
      activeTabId: projectsTabId,
      historyIndex: 1,
    });
    expect(useTabs.getState().viewHistory).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(useTabs.getState().activeTabId).toBe(homeTabId);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("Home");
  });

  it("does not revisit a retained task reopened after the Projects root", () => {
    const homeTabId = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    const taskSpec = {
      kind: "task" as const,
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    };
    useTabs.getState().openTab(taskSpec);
    const projectsTabId = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    useTabs.getState().openTab(taskSpec);
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(useTabs.getState().activeTabId).toBe(projectsTabId);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(useTabs.getState().activeTabId).toBe(homeTabId);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("Home");
  });

  it("moves backward through an existing Projects list history entry without adding a loop", () => {
    const projectsTabId = useTabs.getState().openTab({
      kind: "projects",
      title: "Projects",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(useTabs.getState().activeTabId).toBe(projectsTabId);
    expect(useTabs.getState().viewHistory).toHaveLength(2);
    expect(useTabs.getState().historyIndex).toBe(0);
  });

  it("uses the Projects breadcrumb root to return to the Projects list", () => {
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("HomeProjects");
    const activeTab = useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    );
    expect(activeTab).toMatchObject({ kind: "projects", title: "Projects" });
  });

  it("does not revisit a directly opened task after using the Projects breadcrumb", () => {
    const homeTabId = useTabs.getState().openTab({
      kind: "home",
      title: "Home",
      closable: false,
    });
    useTabs.getState().openTab({
      kind: "task",
      projectSlug: "matrix-os",
      taskId: "MAT-466",
      title: "Fix Desktop navigation",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toBe("HomeProjects");

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(useTabs.getState().activeTabId).toBe(homeTabId);
  });

  it("keeps the sidebar collapse control in the header", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(useUi.getState().sidebarCollapsed).toBe(true);

    act(() => useUi.getState().toggleSidebar());
    expect(useUi.getState().sidebarCollapsed).toBe(false);
  });

  it("shows a refresh control only for Home and requests a hosted-shell reload", () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const refresh = screen.getByRole("button", { name: "Refresh Home" });
    expect(breadcrumb.nextElementSibling).toContain(refresh);
    expect(refresh.parentElement?.className).not.toContain("ml-auto");

    fireEvent.click(refresh);
    expect(useUi.getState().homeRefreshRequest).toBe(1);

    act(() => {
      useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    });
    expect(screen.queryByRole("button", { name: "Refresh Home" })).toBeNull();
  });

  it("returns from a directly opened native Terminal session to the Terminal list", () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "focused-shell",
      title: "focused-shell",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    const activeTab = useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    );
    expect(activeTab).toMatchObject({ kind: "terminals", title: "Terminal" });
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Terminal");
  });

  it("uses the native Terminal breadcrumb root to open the Terminal list", () => {
    useTabs.getState().openTab({
      kind: "terminal",
      sessionName: "focused-shell",
      title: "focused-shell",
    });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    const activeTab = useTabs.getState().tabs.find(
      (tab) => tab.id === useTabs.getState().activeTabId,
    );
    expect(activeTab).toMatchObject({ kind: "terminals", title: "Terminal" });
  });

  it("shows the active canonical Hermes conversation in the Chat breadcrumb", () => {
    useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
    useHermesChat.setState({
      sessionId: "conversation-two",
      view: "conversation",
      conversations: [{
        id: "conversation-two",
        title: "Trip planning",
        preview: "Plan a trip",
        messageCount: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent)
      .toContain("ChatTrip planning");
  });
});
