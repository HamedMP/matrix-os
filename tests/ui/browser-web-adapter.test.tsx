// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSurfaceProps } from "../../packages/ui/src/browser/types";
import { RemoteBrowserView } from "../../shell/src/components/RemoteBrowserView";
let props: BrowserSurfaceProps;
const surface = vi.hoisted(() => ({ real: false }));
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@matrix-os/ui")>();
  return { ...original, BrowserSurface: (value: BrowserSurfaceProps) => {
    props = value; return surface.real ? <original.BrowserSurface {...value}/> : <div/>;
  } };
});
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://app.matrix-os.com/vm/pr-2526" }));
afterEach(() => { cleanup(); surface.real = false; resetWindowManagerLayoutPersistenceForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("web Browser surface adapter", () => {
  it("renews only the selected runtime app cookie with credentialed abortable HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ expiresAt: Date.now() + 600_000 })));
    const open = vi.fn(); render(<RemoteBrowserView surface="browser" onOpenCloudDesktop={open}/>);
    const controller = new AbortController(); await props.ensureSession(controller.signal);
    expect(props.onOpenCloudDesktop).toBe(open);
    expect(fetch).toHaveBeenCalledWith("https://app.matrix-os.com/vm/pr-2526/api/apps/browser-lab/session", expect.objectContaining({
      method: "POST", credentials: "include", body: "{}", redirect: "error", signal: expect.any(AbortSignal),
    }));
    controller.abort(); expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("does not expose a failed session response to the surface", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider detail", { status: 503 })));
    render(<RemoteBrowserView surface="desktop" active={false}/>);
    await expect(props.ensureSession(new AbortController().signal)).rejects.toThrow("Browser session unavailable");
    expect(props.active).toBe(false);
  });
});

import { useWindowManager, resetWindowManagerLayoutPersistenceForTests } from "../../shell/src/hooks/useWindowManager";
import { routeAppBridgeLaunch } from "../../shell/src/lib/builtin-apps";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";
import { DesktopWindow } from "../../shell/src/components/desktop/DesktopWindow";

describe("Browser fullscreen minimize and launcher restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    resetWindowManagerLayoutPersistenceForTests();
    useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), closedLayouts: new Map(), focusedWindowId: null, fullscreenWindowId: null });
  });
    it.each(["desktop", "canvas"] as const)("minimizes a fullscreen Browser and restores its existing window from the %s launcher", (mode) => {
      useDesktopMode.setState({ mode });
      useWindowManager.getState().openWindow("Browser", "__browser__", 80);
      const original = useWindowManager.getState().windows[0];
      useWindowManager.getState().toggleFullscreen(original.id);

      const changed = vi.fn();
      const unsubscribe = useWindowManager.subscribe(changed);
      useWindowManager.getState().minimizeWindow(original.id);

      expect(changed).toHaveBeenCalledOnce();
      expect(useWindowManager.getState()).toMatchObject({
        focusedWindowId: null,
        fullscreenWindowId: null,
        windows: [{ ...original, minimized: true }],
      });
      unsubscribe();

      useWindowManager.getState().openWindow("Browser", "__browser__", 80);
      expect(useWindowManager.getState().windows).toHaveLength(1);
      expect(useWindowManager.getState()).toMatchObject({
        focusedWindowId: original.id,
        fullscreenWindowId: null,
        windows: [{
          id: original.id,
          x: original.x,
          y: original.y,
          width: original.width,
          height: original.height,
          minimized: false,
        }],
      });
    });

    it.each(["desktop", "canvas"] as const)("reveals Cloud desktop launched from fullscreen Browser in %s", (mode) => {
      useDesktopMode.setState({ mode });
      const store = useWindowManager.getState();
      store.openWindow("Browser", "__browser__", 0);
      const browser = useWindowManager.getState().windows[0];
      store.toggleFullscreen(browser.id);
      routeAppBridgeLaunch("Cloud desktop", "__cloud-desktop__", (name, path) => {
        useWindowManager.getState().openWindow(name, path, 0);
      });
      const state = useWindowManager.getState();
      const cloud = state.windows.find(window => window.path === "__cloud-desktop__")!;
      expect(state.focusedWindowId).toBe(cloud.id);
      expect(state.fullscreenWindowId).toBeNull();
      expect(state.windows.find(window => window.id === browser.id)).toEqual(browser);
      store.toggleFullscreen(cloud.id);
      routeAppBridgeLaunch("Cloud desktop", "__cloud-desktop__", (name, path) => {
        useWindowManager.getState().openWindow(name, path, 0);
      });
      expect(useWindowManager.getState().fullscreenWindowId).toBe(cloud.id);
    });
    it("leaves another fullscreen window active when minimizing a background app", () => {
      useWindowManager.getState().openWindow("Browser", "__browser__", 80);
      useWindowManager.getState().openWindow("Cloud desktop", "__cloud-desktop__", 80);
      const [browser, cloudDesktop] = useWindowManager.getState().windows;
      useWindowManager.getState().toggleFullscreen(cloudDesktop.id);

      useWindowManager.getState().minimizeWindow(browser.id);

      expect(useWindowManager.getState().fullscreenWindowId).toBe(cloudDesktop.id);
      expect(useWindowManager.getState().focusedWindowId).toBe(cloudDesktop.id);
      expect(useWindowManager.getState().getWindow(browser.id)?.minimized).toBe(true);
    });

    it.each([
      ["desktop", "new"], ["desktop", "open"], ["desktop", "restore"],
      ["canvas", "new"], ["canvas", "open"], ["canvas", "restore"],
    ] as const)("atomically reveals another app in %s through %s", (mode, action) => {
      useDesktopMode.setState({ mode });
      const manager = useWindowManager.getState();
      manager.openWindow("Browser", "__browser__", 0);
      const browser = useWindowManager.getState().windows[0];
      if (action !== "new") manager.openWindow("Cloud desktop", "__cloud-desktop__", 0);
      const original = useWindowManager.getState().windows.find(win => win.path === "__cloud-desktop__");
      if (action === "restore") manager.minimizeWindow(original!.id);
      manager.toggleFullscreen(browser.id);
      const changed = vi.fn(); const unsubscribe = useWindowManager.subscribe(changed);
      try {
        if (action === "restore") manager.restoreAndFocusWindow(original!.id);
        else manager.openWindow("Cloud desktop", "__cloud-desktop__", 0);
        const state = useWindowManager.getState();
        const cloud = state.windows.find(win => win.path === "__cloud-desktop__")!;
        expect(changed).toHaveBeenCalledOnce();
        expect(state).toMatchObject({ focusedWindowId: cloud.id, fullscreenWindowId: null });
        expect(state.windows).toHaveLength(2);
        if (original) expect(cloud).toMatchObject({
          x: original.x, y: original.y, width: original.width, height: original.height, minimized: false,
        });
        manager.toggleFullscreen(cloud.id);
        manager.restoreAndFocusWindow(cloud.id);
        manager.openWindow("Cloud desktop", "__cloud-desktop__", 0);
        expect(useWindowManager.getState().fullscreenWindowId).toBe(cloud.id);
      } finally { unsubscribe(); }
    });

    it("does not dismiss a fullscreen app for a stale dock window ID", () => {
      const manager = useWindowManager.getState();
      manager.openWindow("Browser", "__browser__", 0);
      manager.toggleFullscreen(useWindowManager.getState().windows[0].id);
      const before = useWindowManager.getState();
      manager.restoreAndFocusWindow("closed-window");
      expect(useWindowManager.getState()).toBe(before);
    });

});

describe("rendered Browser toolbar launch", () => {
  beforeEach(() => {
    surface.real = true;
    resetWindowManagerLayoutPersistenceForTests();
    useDesktopMode.setState({ mode: "desktop" });
    useWindowManager.setState({ windows: [], nextZ: 1, closedPaths: new Set(), closedLayouts: new Map(), focusedWindowId: null, fullscreenWindowId: null });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/browser-status")) return Response.json({ available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true });
      if (String(url).endsWith("/browser-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
      return Response.json({});
    }));
  });

  it("reveals Cloud desktop from the actual fullscreen Browser toolbar in one state change", async () => {
    const manager = useWindowManager.getState();
    manager.openWindow("Cloud desktop", "__cloud-desktop__", 0);
    const cloud = useWindowManager.getState().windows[0]; manager.minimizeWindow(cloud.id);
    manager.openWindow("Browser", "__browser__", 0);
    const browser = useWindowManager.getState().windows.find(win => win.path === "__browser__")!;
    manager.toggleFullscreen(browser.id);
    const noop = () => {};
    const open = (name: string, path: string) => useWindowManager.getState().openWindow(name, path, 0);
    function Windows() {
      const windows = useWindowManager(state => state.windows);
      const fullscreenWindowId = useWindowManager(state => state.fullscreenWindowId);
      return <>{windows.map(win => <DesktopWindow key={win.id} win={win} dockPosition="bottom" fullscreenWindowId={fullscreenWindowId}
        interacting={false} minimizingIds={new Set()} onAnimateMinimize={manager.minimizeWindow} onCloseWindow={manager.closeWindow}
        onDragEnd={noop} onDragMove={noop} onDragStart={noop} onFocusWindow={manager.focusWindow} onOpenWindow={open}
        onResizeInteractionChange={noop} onToggleFullscreen={manager.toggleFullscreen} topInset={38}/>)}</>;
    }
    const view = render(<Windows/>);
    const browserFrame = await screen.findByTitle("Chrome on your Matrix computer") as HTMLIFrameElement;
    const acknowledge = (frame: HTMLIFrameElement) => act(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "matrix-browser-viewer", connected: true }, origin: "https://app.matrix-os.com", source: frame.contentWindow,
    })));
    acknowledge(browserFrame);
    expect(within(screen.getByRole("region", { name: "Browser" })).getByText("Connected")).toBeTruthy();
    const changed = vi.fn(); const unsubscribe = useWindowManager.subscribe(changed);
    try {
      const launch = screen.getByRole("button", { name: "Cloud desktop" });
      fireEvent.mouseDown(launch); fireEvent.click(launch);
      expect(changed).toHaveBeenCalledOnce();
      expect(useWindowManager.getState()).toMatchObject({ fullscreenWindowId: null, focusedWindowId: cloud.id });
      expect(useWindowManager.getState().windows).toHaveLength(2);
      expect(view.container.querySelector(`[data-window-id="${browser.id}"]`)?.classList.contains("fixed")).toBe(false);
      const cloudFrame = await screen.findByTitle("Your Matrix cloud desktop") as HTMLIFrameElement;
      acknowledge(cloudFrame);
      expect(within(screen.getByRole("region", { name: "Cloud desktop" })).getByText("Connected")).toBeTruthy();
      expect(within(screen.getByRole("region", { name: "Browser" })).getByText("Ready when you return")).toBeTruthy();
      expect(useWindowManager.getState().windows.find(win => win.id === cloud.id)).toMatchObject({
        x: cloud.x, y: cloud.y, width: cloud.width, height: cloud.height, minimized: false,
      });
    } finally { unsubscribe(); }
  });
});
