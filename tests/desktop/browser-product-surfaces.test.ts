import { beforeEach, describe, expect, it } from "vitest";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { reconcileNativeProductSurfaces } from "@desktop/renderer/src/features/desktop-shell/browser-product-surfaces";
import { remoteBrowserWindowSize } from "@matrix-os/contracts";
beforeEach(() => { useTabs.setState(useTabs.getInitialState(), true); useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true); });
describe("native product surface geometry", () => {
  it("starts products near full work area, preserves saved bounds and restores the same minimized identity", () => {
    const viewport = { width: 1200, height: 800 };
    const id = useTabs.getState().openTab({ kind: "app", slug: "browser-lab", appIdentity: "matrix-browser", title: "Browser" });
    reconcileNativeProductSurfaces([id], viewport);
    expect(useDesktopSurfaces.getState().surfaces[id]?.bounds).toMatchObject(remoteBrowserWindowSize(viewport));
    useDesktopSurfaces.getState().setSurfaceBounds(id, { x: 50, y: 60, width: 600, height: 420 }, viewport);
    useDesktopSurfaces.getState().minimizeSurface(id);
    expect(useTabs.getState().openTab({ kind: "app", slug: "browser-lab", appIdentity: "matrix-browser", title: "Browser" })).toBe(id);
    reconcileNativeProductSurfaces([id], viewport);
    useDesktopSurfaces.getState().activateSurface(id);
    expect(useDesktopSurfaces.getState().surfaces[id]).toMatchObject({ mode: "window", bounds: { x: 50, y: 60, width: 600, height: 420 } });
  });
  it("preserves generic browser default geometry", () => {
    const id = useTabs.getState().openTab({ kind: "browser", title: "Browser" });
    reconcileNativeProductSurfaces([id], { width: 1200, height: 800 });
    expect(useDesktopSurfaces.getState().surfaces[id]?.bounds.width).toBe(816);
  });
});
