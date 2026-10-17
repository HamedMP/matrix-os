import { remoteBrowserWindowSize } from "@matrix-os/contracts";
import { nativeBrowserProduct } from "../../../../shared/browser-products";
import { useTabs } from "../../stores/tabs";
import { useDesktopSurfaces, desktopSurfaceBounds, type DesktopViewport } from "../../stores/desktop-surfaces";

/** Product defaults apply once; existing owner geometry always wins. */
export function reconcileNativeProductSurfaces(tabIds: readonly string[], viewport: DesktopViewport, constrain = true): void {
  const before = useDesktopSurfaces.getState().surfaces;
  useDesktopSurfaces.getState().reconcileTabs(tabIds, viewport, constrain);
  const state = useDesktopSurfaces.getState();
  const surfaces = { ...state.surfaces };
  let changed = false;
  for (const tab of useTabs.getState().tabs) {
    const surface = surfaces[tab.id];
    if (before[tab.id] || !surface || tab.kind !== "app" || !nativeBrowserProduct(tab.appIdentity ?? "", tab.slug ?? "")) continue;
    const size = remoteBrowserWindowSize(viewport);
    surfaces[tab.id] = { ...surface, bounds: desktopSurfaceBounds({ ...size,
      x: Math.round((viewport.width - size.width) / 2), y: Math.round((viewport.height - size.height) / 2) }, viewport) };
    changed = true;
  }
  if (changed) useDesktopSurfaces.setState({ surfaces });
}
