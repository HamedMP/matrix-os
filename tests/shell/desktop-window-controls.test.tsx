// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopWindow,
  desktopWindowTitleBarStyle,
  desktopWindowTop,
  WindowControls,
} from "@/components/desktop/DesktopWindow";
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
      paddingTop: 0,
      paddingBottom: 0,
      borderBottom: "1px solid var(--border)",
    });
  });

  it("matches the desktop OS square icon controls", () => {
    render(
      <WindowControls
        title="Terminal"
        onClose={vi.fn()}
        onMinimize={vi.fn()}
        onMaximize={vi.fn()}
      />,
    );

    const close = screen.getByRole("button", { name: "Close Terminal" });
    const minimize = screen.getByRole("button", { name: "Minimize Terminal" });
    const maximize = screen.getByRole("button", { name: "Maximize Terminal" });

    for (const control of [close, minimize, maximize]) {
      expect(control.className).toContain("size-4");
      expect(control.className).toContain("rounded-[4.8px]");
      expect((control as HTMLElement).style.background).toBe("var(--surface-primary, #FFFEFC)");
      expect((control as HTMLElement).style.border).toBe("0.8px solid var(--border-default, #F3F2F2)");
      expect(control.querySelector("svg")).toBeTruthy();
      expect(control.querySelector("[data-window-control-light]")).toBeNull();
    }

    expect(close.parentElement?.className).toContain("gap-0.5");
    expect(close.parentElement?.className).not.toContain("w-16");
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
});
