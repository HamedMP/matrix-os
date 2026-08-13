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
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("Desktop navigation header", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useTabs.getState().ensureNavigationScope("runtime-a");
    useUi.setState({ sidebarCollapsed: false });
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
});
