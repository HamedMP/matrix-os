// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopWindow,
  desktopWindowTitleBarStyle,
  desktopWindowTop,
  hasActiveWindowInteraction,
} from "@/components/desktop/DesktopWindow";
import { TrafficLights } from "@/components/desktop/DesktopDockControls";
import type { AppWindow } from "@/hooks/useWindowManager";

vi.mock("@/components/AppViewer", () => ({
  AppViewer: () => <div data-testid="app-viewer" />,
}));

describe("web desktop window controls", () => {
  it("keeps floating windows below the desktop header", () => {
    expect(desktopWindowTop(20, 38)).toBe("58px");
  });

  it("centers title-bar content with equal vertical clearance", () => {
    expect(desktopWindowTitleBarStyle(false)).toMatchObject({
      alignItems: "center",
      height: 48,
      paddingTop: 10,
      paddingBottom: 10,
      borderBottom: "1px solid var(--border)",
    });
  });

  it("keeps Main's colored macOS traffic lights in the web desktop", () => {
    render(
      <TrafficLights
        onClose={vi.fn()}
        onMinimize={vi.fn()}
        onFullscreen={vi.fn()}
      />,
    );

    const close = screen.getByRole("button", { name: "Close" });
    const minimize = screen.getByRole("button", { name: "Minimize" });
    const fullscreen = screen.getByRole("button", { name: "Fullscreen" });

    expect(close.className).toContain("size-3");
    expect(close.className).toContain("rounded-full");
    expect(close.className).toContain("bg-[#ff5f57]");
    expect(minimize.className).toContain("bg-[#febc2e]");
    expect(fullscreen.className).toContain("bg-[#28c840]");
    expect(close.querySelector("svg")).toBeTruthy();
    expect(minimize.querySelector("svg")).toBeTruthy();
    expect(fullscreen.querySelector("svg")).toBeTruthy();
    expect(close.parentElement?.className).toContain("gap-1.5");
  });

  it("ends header drags and corner resizes when the browser cancels the pointer", () => {
    const onDragEnd = vi.fn();
    const onResizeEnd = vi.fn();
    const win: AppWindow = {
      id: "window-1",
      title: "Demo",
      path: "apps/demo/dist/index.html",
      x: 20,
      y: 20,
      width: 640,
      height: 480,
      minimized: false,
      zIndex: 10,
    };

    const { container } = render(
      <DesktopWindow
        win={win}
        dockPosition="bottom"
        fullscreenWindowId={null}
        interacting
        minimizingIds={new Set()}
        onAnimateMinimize={vi.fn()}
        onCloseWindow={vi.fn()}
        onDragEnd={onDragEnd}
        onDragMove={vi.fn()}
        onDragStart={vi.fn()}
        onFocusWindow={vi.fn()}
        onOpenWindow={vi.fn()}
        onResizeEnd={onResizeEnd}
        onResizeMove={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleFullscreen={vi.fn()}
        topInset={38}
      />,
    );

    fireEvent.pointerCancel(container.querySelector('[data-slot="card-header"]')!);
    fireEvent.pointerCancel(container.querySelector(".cursor-se-resize")!);

    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(onResizeEnd).toHaveBeenCalledOnce();
  });

  it("stays interactive until both overlapping pointer interactions finish", () => {
    const drag = { id: "drag" };
    const resize = { id: "resize" };

    expect(hasActiveWindowInteraction(null, resize)).toBe(true);
    expect(hasActiveWindowInteraction(drag, null)).toBe(true);
    expect(hasActiveWindowInteraction(null, null)).toBe(false);
  });
});
