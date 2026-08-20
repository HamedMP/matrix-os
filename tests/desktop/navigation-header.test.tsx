// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NavigationHeader, {
  breadcrumbItemsForTab,
  breadcrumbsForTab,
} from "../../desktop/src/renderer/src/features/mission-control/NavigationHeader";
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
    expect(breadcrumbsForTab(project)).toEqual(["Projects", "Matrix OS"]);
    expect(breadcrumbsForTab(task)).toEqual(["Projects", "matrix-os", "Desktop navigation"]);
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
      { key: "projects", label: "Projects" },
      { key: "projects/matrix-os", label: "Matrix OS" },
    ]);
    expect(breadcrumbItemsForTab(task)).toEqual([
      { key: "projects", label: "Projects" },
      { key: "projects/matrix-os", label: "matrix-os" },
      { key: "projects/matrix-os/tasks/MAT-301", label: "Desktop navigation" },
    ]);
    expect(breadcrumbItemsForTab({ ...task, title: "Renamed navigation" }).map((item) => item.key))
      .toEqual(breadcrumbItemsForTab(task).map((item) => item.key));
  });

  it("drives Back and Forward while keeping the cached tabs present", () => {
    const home = useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    const terminal = useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    expect(screen.getByRole("button", { name: "Go forward" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(useTabs.getState().activeTabId).toBe(home);
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([home, terminal]);
    expect(screen.getByText("Home")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));
    expect(useTabs.getState().activeTabId).toBe(terminal);
    expect(screen.getByText("dev")).toBeTruthy();
  });

  it("keeps the sidebar collapse control in the header", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(useUi.getState().sidebarCollapsed).toBe(true);

    act(() => useUi.getState().toggleSidebar());
    expect(useUi.getState().sidebarCollapsed).toBe(false);
  });

  it("matches the Figma top-bar geometry and navigation-action order", () => {
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    const header = screen.getByRole("banner");
    expect(header.style.height).toBe("var(--titlebar-height)");
    expect(header.style.gridTemplateColumns).toBe("var(--sidebar-expanded-width) minmax(0, 1fr)");
    expect(header.style.borderBottom).toBe("");

    const actionGroup = screen.getByTestId("sidebar-navigation-actions");
    expect(actionGroup.style.gap).toBe("8px");

    const actions = [
      screen.getByRole("button", { name: "Go back" }),
      screen.getByRole("button", { name: "Go forward" }),
      screen.getByRole("button", { name: "Collapse sidebar" }),
    ];
    for (let index = 1; index < actions.length; index += 1) {
      expect(actions[index - 1]!.compareDocumentPosition(actions[index]!))
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    for (const action of actions) {
      const icon = action.querySelector<HTMLElement>("[data-header-icon]");
      expect(icon?.style.width).toBe("14px");
      expect(icon?.style.height).toBe("14px");
    }
  });

  it("places Home actions behind the Figma breadcrumb ellipsis", async () => {
    useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
    render(<Tooltip.Provider><NavigationHeader /></Tooltip.Provider>);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb.querySelector(".lucide-chevron-right")).toBeTruthy();
    const actions = screen.getByRole("button", { name: "Actions for Home" });
    expect(breadcrumb.nextElementSibling).toContain(actions);

    fireEvent.pointerDown(actions, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh Home" }));
    expect(useUi.getState().homeRefreshRequest).toBe(1);

    act(() => {
      useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    });
    expect(screen.queryByRole("menuitem", { name: "Refresh Home" })).toBeNull();
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
