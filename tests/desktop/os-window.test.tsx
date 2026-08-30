// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OSWindow, OSWindowSafeView, TopBar } from "../../desktop/src/renderer/src/features/desktop-shell/OSWindow.js";

describe("Electron OS window chrome", () => {
  it("uses the shared base surface for every OS window", () => {
    const { container } = render(
      <OSWindow surfaceId="terminal-window" sidebarWidth={280} topBar={<div data-test-top-bar />} className="absolute" />,
    );

    const window = container.firstElementChild as HTMLElement;
    expect(window.style.background).toBe("var(--surface-base-background, #FFFFFD)");
    expect(window.className).not.toContain("relative");
    expect(window.style.getPropertyValue("--bg-surface")).toBe("var(--surface-base-background, #FFFFFD)");
    expect(window.style.getPropertyValue("--bg-sunken")).toBe("var(--surface-base-background, #FFFFFD)");
    const sidebar = container.querySelector("[data-os-window-sidebar]") as HTMLElement;
    expect(sidebar.style.width).toBe("280px");
    expect(sidebar.style.minWidth).toBe("200px");
    expect(sidebar.style.maxWidth).toBe("280px");
    expect(sidebar.style.borderRight).toBe("1px solid var(--border-default, #F3F2F2)");
    expect(sidebar.className).not.toContain("absolute");
    expect(container.querySelector("[data-os-window-main]")).toBeTruthy();
    expect(container.querySelector("[data-os-window-body]")?.className).toContain("absolute");
    expect(container.querySelector("[data-os-window-top-bar-overlay]")?.className).toContain("absolute");
  });

  it("keeps the transparent gesture layer full width when chrome uses the sidebar", () => {
    const onClose = vi.fn();
    const { container } = render(
      <TopBar
        chromePlacement="sidebar"
        onClose={onClose}
        onMinimize={vi.fn()}
        onMaximize={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    const gestureLayer = container.querySelector("[data-os-window-gesture-layer]") as HTMLElement;
    expect(gestureLayer).toBeTruthy();
    expect(gestureLayer?.className).toContain("z-20");
    expect(gestureLayer.className).toContain("inset-0");
    expect(gestureLayer.style.width).toBe("");
    expect((container.querySelector('[data-os-window-chrome-placement="sidebar"]') as HTMLElement).style.width).toBe("280px");
    expect(gestureLayer?.className).not.toContain("bg-");
    expect(container.querySelector("[data-os-window-traffic-lights]")?.className).toContain("z-30");
    expect(screen.queryByText("Terminal")).toBeNull();

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("size-3");
    expect(closeButton.className).toContain("rounded-full");
    expect(closeButton.className).toContain("bg-[#ff5f57]");
    expect(screen.getByRole("button", { name: "Minimize" }).className).toContain("bg-[#febc2e]");
    expect(screen.getByRole("button", { name: "Maximize" }).className).toContain("bg-[#28c840]");
    expect(closeButton.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimize" }).querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" }).querySelector("svg")).toBeTruthy();
    expect(closeButton.querySelector("svg")?.getAttribute("class")).toContain("text-black/0");
    expect(closeButton.querySelector("svg")?.getAttribute("class")).toContain("group-hover/traffic:text-black/60");
    expect(closeButton.parentElement?.className).toContain("gap-1.5");

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("places Chat pane controls and title in the shared top row without window controls when maximized", () => {
    render(
      <TopBar
        title="Release planning"
        leftActions={<button type="button">Toggle navigation</button>}
        rightActions={<button type="button">Toggle inspector</button>}
        leftPaneWidth={260}
        rightPaneWidth={640}
        showWindowControls={false}
      />,
    );

    expect(screen.getByText("Release planning")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle inspector" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Release planning" })).toBeNull();
    const chromeGrid = screen.getByTestId("os-window-chrome-grid");
    expect(chromeGrid.className).toContain("border-b");
    expect((chromeGrid as HTMLElement).style.gridTemplateColumns).toBe("260px minmax(0, 1fr) 640px");
    const title = screen.getByText("Release planning");
    expect(title.parentElement?.className).toContain("justify-start");
    expect(title.parentElement?.className).toContain("text-[15px]");
  });

  it("mirrors open pane toggles at their inner edges and closed toggles at the window edges", () => {
    const { rerender } = render(
      <TopBar
        leftActions={<button type="button">Toggle navigation</button>}
        rightActions={<button type="button">Toggle inspector</button>}
        leftPaneWidth={260}
        rightPaneWidth={640}
        showWindowControls={false}
      />,
    );

    const openNavigation = screen.getByRole("button", { name: "Toggle navigation" });
    const openInspector = screen.getByRole("button", { name: "Toggle inspector" });
    expect(openNavigation.parentElement?.className).toContain("ml-auto");
    expect(openInspector.parentElement?.parentElement?.className).toContain("justify-start");

    rerender(
      <TopBar
        leftActions={<button type="button">Toggle navigation</button>}
        rightActions={<button type="button">Toggle inspector</button>}
        leftPaneWidth={0}
        rightPaneWidth={0}
        showWindowControls={false}
      />,
    );

    const closedNavigation = screen.getByRole("button", { name: "Toggle navigation" });
    const closedInspector = screen.getByRole("button", { name: "Toggle inspector" });
    expect(closedNavigation.parentElement?.className).not.toContain("ml-auto");
    expect(closedInspector.parentElement?.className).toContain("ml-auto");
  });

  it("keeps the gesture layer full width for full-width window chrome", () => {
    const { container } = render(
      <TopBar
        onClose={vi.fn()}
        onMinimize={vi.fn()}
        onMaximize={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    const gestureLayer = container.querySelector("[data-os-window-gesture-layer]") as HTMLElement;
    expect(gestureLayer.className).toContain("inset-0");
    expect(gestureLayer.style.width).toBe("");
  });

  it("applies topbar clearance only to the safe area for each window layout", () => {
    const { container, rerender } = render(
      <OSWindow
        surfaceId="terminal-window"
        sidebarWidth={280}
        safeAreaLayout="sidebar"
        topBar={<div />}
        sidebar={<OSWindowSafeView area="sidebar" data-testid="sidebar-safe-view" />}
      >
        <OSWindowSafeView area="pane" data-testid="pane-safe-view" />
      </OSWindow>,
    );

    expect((screen.getByTestId("sidebar-safe-view") as HTMLElement).style.paddingTop).toBe("48px");
    expect((screen.getByTestId("pane-safe-view") as HTMLElement).style.paddingTop).toBe("");

    rerender(
      <OSWindow surfaceId="project-window" safeAreaLayout="pane" topBar={<div />}>
        <div />
      </OSWindow>,
    );

    expect((container.querySelector('[data-os-window-safe-view="pane"]') as HTMLElement).style.paddingTop).toBe("48px");

    rerender(
      <OSWindow surfaceId="project-tab" safeAreaLayout="pane">
        <div />
      </OSWindow>,
    );

    expect((container.querySelector('[data-os-window-safe-view="pane"]') as HTMLElement).style.paddingTop).toBe("");
    expect(container.querySelector("[data-os-window-top-bar-overlay]")).toBeNull();
  });
});
