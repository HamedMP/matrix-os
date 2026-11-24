// Window arrangement for Electron Desktop (specs/653, "Window arrangement"):
// move the selected app to a half of the desktop and restore its earlier size.
// Shared by the Apps shortcuts and the window drag path, so a keyboard tile
// saves its placement exactly as a drag does.
import {
  isDesktopSurfaceVisible,
  useDesktopSurfaces,
  type DesktopSurfaceBounds,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { useTabs } from "../../stores/tabs";
import { desktopShellEffects, restoreAppAsWindow, type DesktopShellEffects } from "./app-switching";

export type TileSide = "left" | "right" | "top" | "bottom";

/** A half of the shell's desktop viewport; the two halves of an axis cover it exactly. */
export function tileBounds(side: TileSide, viewport: DesktopViewport): DesktopSurfaceBounds {
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  switch (side) {
    case "left": return { x: 0, y: 0, width: halfWidth, height };
    case "right": return { x: halfWidth, y: 0, width: width - halfWidth, height };
    case "top": return { x: 0, y: 0, width, height: halfHeight };
    case "bottom": return { x: 0, y: halfHeight, width, height: height - halfHeight };
  }
}

/**
 * The selected app when it can be arranged: shown on the desktop, or minimized
 * while still selected. Arranging needs the mounted shell's viewport, and acts
 * only on the Desktop presentation (Canvas windows are not placed on the screen).
 */
function arrangeableApp(): { tabId: string; effects: DesktopShellEffects } | null {
  const effects = desktopShellEffects();
  if (!effects || useNativeDesktopMode.getState().mode === "canvas") return null;
  const tabId = useTabs.getState().activeTabId;
  if (!tabId) return null;
  const surfaces = useDesktopSurfaces.getState();
  const mode = surfaces.surfaces[tabId]?.mode;
  if (mode !== "minimized" && !isDesktopSurfaceVisible(tabId, surfaces)) return null;
  return { tabId, effects };
}

function ensureFloatingWindow(tabId: string): void {
  if (useDesktopSurfaces.getState().surfaces[tabId]?.mode !== "window") restoreAppAsWindow(tabId);
}

/** Moves the selected app to a half of the desktop, first making it a floating window. */
export function tileActiveApp(side: TileSide): void {
  const target = arrangeableApp();
  if (!target) return;
  // Only the first tile records: tiling left then right still restores the original size.
  useDesktopSurfaces.getState().rememberTileRestoreBounds(target.tabId);
  ensureFloatingWindow(target.tabId);
  target.effects.applyWindowBounds(target.tabId, tileBounds(side, target.effects.viewport()));
}

/**
 * Returns the selected app to its floating size from before the first tile.
 * With nothing remembered, a full-size or minimized app becomes its floating
 * window again and a floating window stays as it is.
 */
export function restoreActiveAppSize(): void {
  const target = arrangeableApp();
  if (!target) return;
  const remembered = useDesktopSurfaces.getState().tileRestoreBounds[target.tabId];
  ensureFloatingWindow(target.tabId);
  if (!remembered) return;
  useDesktopSurfaces.getState().forgetTileRestoreBounds(target.tabId);
  target.effects.applyWindowBounds(target.tabId, remembered);
}

/** A drag or resize by the user: the new placement replaces any remembered size. */
export function moveAppWindow(tabId: string, bounds: DesktopSurfaceBounds): void {
  useDesktopSurfaces.getState().forgetTileRestoreBounds(tabId);
  desktopShellEffects()?.applyWindowBounds(tabId, bounds);
}
