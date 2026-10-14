// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSurfaceProps } from "../../packages/ui/src/browser/types";
import { RemoteBrowserView } from "../../shell/src/components/RemoteBrowserView";
let props: BrowserSurfaceProps;
vi.mock("@matrix-os/ui", async (importOriginal) => ({ ...await importOriginal<typeof import("@matrix-os/ui")>(), BrowserSurface: (value: BrowserSurfaceProps) => { props = value; return <div/>; } }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://app.matrix-os.com/vm/pr-2526" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";

describe("Browser fullscreen minimize and launcher restore", () => {
  beforeEach(() => {
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

});
