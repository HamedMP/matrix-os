// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager } from "../../shell/src/hooks/useWindowManager";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";
import { desktopSurfaceBounds } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { NATIVE_DESKTOP_LAYOUT } from "../../desktop/src/renderer/src/design/layering";

// Visible launch bar with a running app: 44px icon + 2px gap + 4px indicator,
// 8px running-section padding, 6px top padding, 2px border, 12px bottom offset.
const LAUNCH_BAR_OCCUPIED_HEIGHT = 78;
const HEADER_HEIGHT = 38;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
const savedTerminal = {
  path: "__terminal__", title: "Terminal", x: 200, y: 160,
  width: 1040, height: 680, state: "open" as const,
};

function viewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function expectWindowAboveLaunchBar() {
  const win = useWindowManager.getState().windows[0];
  expect(win.y + HEADER_HEIGHT + win.height).toBeLessThanOrEqual(
    window.innerHeight - LAUNCH_BAR_OCCUPIED_HEIGHT,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  resetWindowManagerLayoutPersistenceForTests();
  useDesktopMode.setState({ mode: "desktop", previousMode: null, _hydrated: true });
  useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), closedLayouts: new Map(), focusedWindowId: null, fullscreenWindowId: null });
  viewport(900, 600);
});

afterEach(() => {
  resetWindowManagerLayoutPersistenceForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  viewport(originalViewport.width, originalViewport.height);
});

describe("visible launch bar window boundary", () => {
  it("opens a fresh Web Desktop Terminal above the launch bar on a short viewport", () => {
    useWindowManager.getState().openWindow("Terminal", "__terminal__", 20);
    expectWindowAboveLaunchBar();
  });

  it.each(["open", "closed"] as const)("fits a persisted %s Web Desktop Terminal above the launch bar", (state) => {
    useWindowManager.getState().loadLayout([{ ...savedTerminal, state }]);
    if (state === "closed") useWindowManager.getState().openWindow("Terminal", "__terminal__", 20);
    expectWindowAboveLaunchBar();
  });

  it("keeps the stationary top edge when a south resize reaches the launch bar", () => {
    useWindowManager.getState().loadLayout([{ ...savedTerminal, x: 100, y: 40, width: 640, height: 300 }]);
    const win = useWindowManager.getState().windows[0];
    useWindowManager.getState().resizeWindow(win.id, win.width, 900, { x: win.x, y: win.y });
    expect(useWindowManager.getState().windows[0].y).toBe(win.y);
    expectWindowAboveLaunchBar();
  });

  it("reconciles Web Desktop windows above the launch bar after viewport shrink", () => {
    viewport(1440, 1000);
    useWindowManager.getState().loadLayout([savedTerminal]);
    viewport(900, 600);
    useWindowManager.getState().reconcileWindowsToViewport();
    expectWindowAboveLaunchBar();
  });

  it("keeps Electron Desktop floating windows above its visible launch bar", () => {
    const bounds = desktopSurfaceBounds(savedTerminal, {
      width: window.innerWidth,
      height: window.innerHeight - NATIVE_DESKTOP_LAYOUT.tabStripHeight - NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight,
    });
    expect(bounds.y + NATIVE_DESKTOP_LAYOUT.tabStripHeight + bounds.height).toBeLessThanOrEqual(
      window.innerHeight - LAUNCH_BAR_OCCUPIED_HEIGHT,
    );
  });

  it("preserves Web Canvas spatial coordinates while restoring and resizing", () => {
    useDesktopMode.setState({ mode: "canvas" });
    useWindowManager.getState().loadLayout([savedTerminal]);
    const win = useWindowManager.getState().windows[0];
    expect(win).toMatchObject({ x: 200, y: 160, width: 1040, height: 680 });
    useWindowManager.getState().resizeWindow(win.id, 1200, 900);
    useWindowManager.getState().reconcileWindowsToViewport();
    expect(useWindowManager.getState().windows[0]).toMatchObject({ x: 200, y: 160, width: 1200, height: 900 });
  });
});
