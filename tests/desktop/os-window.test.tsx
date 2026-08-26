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

  it("keeps a full-width transparent gesture layer when Terminal controls use the sidebar", () => {
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

    const gestureLayer = container.querySelector("[data-os-window-gesture-layer]");
    expect(gestureLayer).toBeTruthy();
    expect(gestureLayer?.className).toContain("z-20");
    expect((container.querySelector('[data-os-window-chrome-placement="sidebar"]') as HTMLElement).style.width).toBe("280px");
    expect(gestureLayer?.className).not.toContain("bg-");
    expect(container.querySelector("[data-os-window-traffic-lights]")?.className).toContain("z-30");
    expect(screen.queryByText("Terminal")).toBeNull();

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("size-4");
    expect(closeButton.className).toContain("rounded-[4.8px]");
    expect((closeButton as HTMLElement).style.background).toBe("var(--surface-primary, #FFFEFC)");

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
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

    expect((screen.getByTestId("sidebar-safe-view") as HTMLElement).style.paddingTop).toBe("38px");
    expect((screen.getByTestId("pane-safe-view") as HTMLElement).style.paddingTop).toBe("");

    rerender(
      <OSWindow surfaceId="project-window" safeAreaLayout="pane" topBar={<div />}>
        <div />
      </OSWindow>,
    );

    expect((container.querySelector('[data-os-window-safe-view="pane"]') as HTMLElement).style.paddingTop).toBe("38px");

    rerender(
      <OSWindow surfaceId="project-tab" safeAreaLayout="pane">
        <div />
      </OSWindow>,
    );

    expect((container.querySelector('[data-os-window-safe-view="pane"]') as HTMLElement).style.paddingTop).toBe("");
    expect(container.querySelector("[data-os-window-top-bar-overlay]")).toBeNull();
  });
});
