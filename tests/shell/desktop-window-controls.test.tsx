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
import {
  useWindowManager,
  resetWindowManagerLayoutPersistenceForTests,
  type AppWindow,
} from "@/hooks/useWindowManager";

const viewerProps=vi.hoisted(()=>({current: null as null | {onOpenApp: unknown;visible?: boolean}}));
vi.mock("@/components/AppViewer", () => ({
  AppViewer: (props: {onOpenApp: unknown;visible?: boolean}) => { viewerProps.current=props; return <div data-testid="app-viewer" />; },
}));

describe("web desktop window controls", () => {
  it("hides a fullscreen Browser with the yellow control and restores the same window from the launcher", () => {
    resetWindowManagerLayoutPersistenceForTests();
    useWindowManager.setState({
      windows: [], nextZ: 1, closedPaths: new Set(), closedLayouts: new Map(),
      focusedWindowId: null, fullscreenWindowId: null,
    });
    useWindowManager.getState().openWindow("Browser", "__browser__", 80);
    const original = useWindowManager.getState().windows[0];
    useWindowManager.getState().toggleFullscreen(original.id);
    const noop = vi.fn();

    function BrowserDesktop() {
      const win = useWindowManager((state) => state.windows[0]);
      const fullscreenWindowId = useWindowManager((state) => state.fullscreenWindowId);
      return <>
        <button onClick={() => useWindowManager.getState().openWindow("Browser", "__browser__", 80)}>
          Open Browser
        </button>
        <DesktopWindow
          win={win}
          dockPosition="bottom"
          fullscreenWindowId={fullscreenWindowId}
          interacting={false}
          minimizingIds={new Set()}
          onAnimateMinimize={useWindowManager.getState().minimizeWindow}
          onCloseWindow={useWindowManager.getState().closeWindow}
          onDragEnd={noop}
          onDragMove={noop}
          onDragStart={noop}
          onFocusWindow={useWindowManager.getState().focusWindow}
          onOpenWindow={noop}
          onResizeInteractionChange={noop}
          onToggleFullscreen={useWindowManager.getState().toggleFullscreen}
          topInset={38}
        />
      </>;
    }

    const view = render(<BrowserDesktop />);
    try {
      const frame = view.container.querySelector<HTMLElement>("[data-window-id]")!;
      fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
      expect(frame.style.display).toBe("none");

      fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));
      expect(view.container.querySelector("[data-window-id]")).toBe(frame);
      expect(frame.style.display).toBe("");
      expect(useWindowManager.getState().focusedWindowId).toBe(original.id);
      expect(useWindowManager.getState().windows).toHaveLength(1);
      expect(useWindowManager.getState().windows[0]).toMatchObject({
        x: original.x, y: original.y, width: original.width, height: original.height,
      });
    } finally {
      view.unmount();
      resetWindowManagerLayoutPersistenceForTests();
    }
  });

  it("reserves the visible launch bar below a maximized Web Desktop app", () => {
    const win: AppWindow = {
      id: "maximized-demo", title: "Demo", path: "apps/demo/dist/index.html",
      x: 20, y: 20, width: 640, height: 480, minimized: false, zIndex: 10,
    };
    const noop = vi.fn();
    const { container } = render(
      <DesktopWindow
        win={win}
        dockPosition="bottom"
        fullscreenWindowId={win.id}
        interacting={false}
        minimizingIds={new Set()}
        onAnimateMinimize={noop}
        onCloseWindow={noop}
        onDragEnd={noop}
        onDragMove={noop}
        onDragStart={noop}
        onFocusWindow={noop}
        onOpenWindow={noop}
        onResizeInteractionChange={noop}
        onToggleFullscreen={noop}
        topInset={38}
      />,
    );
    const frame = container.querySelector<HTMLElement>("[data-window-id]")!;
    expect(frame.style.top).toBe("38px");
    // Tailwind inset-0 supplies bottom:0 unless the maximized frame overrides it.
    // The visible bar occupies 66px plus its 12px bottom offset.
    expect(Number.parseFloat(frame.style.bottom || "0")).toBeGreaterThanOrEqual(78);
  });

  it("keeps floating windows below the desktop header", () => {
    expect(desktopWindowTop(20, 38)).toBe("58px");
  });

  it("hides portal-backed app controls throughout minimize and restores them with the window", () => {
    const win: AppWindow = {
      id: "window-1", title: "Demo", path: "apps/demo/dist/index.html",
      x: 20, y: 20, width: 640, height: 480, minimized: false, zIndex: 10,
    };
    const noop = vi.fn();
    const props = { dockPosition: "bottom" as const, fullscreenWindowId: null, interacting: false,
      onAnimateMinimize: noop, onCloseWindow: noop, onDragEnd: noop, onDragMove: noop,
      onDragStart: noop, onFocusWindow: noop, onOpenWindow: noop,
      onResizeInteractionChange: noop, onToggleFullscreen: noop };
    const view = render(<DesktopWindow {...props} win={win} minimizingIds={new Set()} />);
    expect(viewerProps.current?.visible).toBe(true);
    view.rerender(<DesktopWindow {...props} win={win} minimizingIds={new Set([win.id])} />);
    expect(viewerProps.current?.visible).toBe(false);
    view.rerender(<DesktopWindow {...props} win={{...win,minimized:true}} minimizingIds={new Set()} />);
    expect(viewerProps.current?.visible).toBe(false);
    view.rerender(<DesktopWindow {...props} win={win} minimizingIds={new Set()} />);
    expect(viewerProps.current?.visible).toBe(true);
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
    expect(close.querySelector("svg")?.getAttribute("class")).toContain("text-black/0");
    expect(close.querySelector("svg")?.getAttribute("class")).toContain("group-hover/traffic:text-black/60");
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
        onResizeInteractionChange={onResizeEnd}
        onToggleFullscreen={vi.fn()}
        topInset={38}
      />,
    );

    fireEvent.pointerCancel(container.querySelector('[data-slot="card-header"]')!);
    expect(container.querySelectorAll("[data-window-resize]")).toHaveLength(8);
    fireEvent.pointerDown(container.querySelector('[data-window-resize="se"]')!, { button: 0 });
    fireEvent.pointerCancel(window);

    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(onResizeEnd).toHaveBeenLastCalledWith(false);
  });

  it("stays interactive until both overlapping pointer interactions finish", () => {
    const drag = { id: "drag" };
    const resize = { id: "resize" };

    expect(hasActiveWindowInteraction(null, resize)).toBe(true);
    expect(hasActiveWindowInteraction(drag, null)).toBe(true);
    expect(hasActiveWindowInteraction(null, null)).toBe(false);
  });
});

it("keeps the app bridge callback stable while window chrome rerenders",()=>{
    const win: AppWindow = {
      id: "maximized-demo", title: "Demo", path: "apps/demo/dist/index.html",
      x: 20, y: 20, width: 640, height: 480, minimized: false, zIndex: 10,
    };
    const noop = vi.fn();
    const view = render(
      <DesktopWindow
        win={win}
        dockPosition="bottom"
        fullscreenWindowId={win.id}
        interacting={false}
        minimizingIds={new Set()}
        onAnimateMinimize={noop}
        onCloseWindow={noop}
        onDragEnd={noop}
        onDragMove={noop}
        onDragStart={noop}
        onFocusWindow={noop}
        onOpenWindow={noop}
        onResizeInteractionChange={noop}
        onToggleFullscreen={noop}
        topInset={38}
      />,
    );
const callback=viewerProps.current?.onOpenApp;
expect(typeof callback).toBe("function");
view.rerender(<DesktopWindow
        win={{...win,width:720}}
        dockPosition="bottom"
        fullscreenWindowId={win.id}
        interacting={false}
        minimizingIds={new Set()}
        onAnimateMinimize={noop}
        onCloseWindow={noop}
        onDragEnd={noop}
        onDragMove={noop}
        onDragStart={noop}
        onFocusWindow={noop}
        onOpenWindow={noop}
        onResizeInteractionChange={noop}
        onToggleFullscreen={noop}
        topInset={38}
      />);
expect(viewerProps.current?.onOpenApp).toBe(callback);
});
