import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager, type AppWindow } from "@/hooks/useWindowManager";
import { isRetiredBuiltInAppPath } from "@/lib/builtin-apps";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { useDesktopMode } from "@/stores/desktop-mode";

/**
 * How Web Desktop and Web Canvas bring an app window forward, wherever the request comes from (the dock, the palette,
 * another app's "Open in Chat"): the same window is reused, a new one opens clear of the dock, and Canvas pans to it.
 */

/** Where a new window opens from the left edge: clear of a dock on the left. */
export function shellWindowXOffset(dock: { readonly position: string; readonly size: number }): number {
  return dock.position === "left" ? dock.size + 16 : 20;
}

/** In Canvas mode, pans the view to center on a window once it is laid out. */
function panCanvasTo(find: () => AppWindow | undefined): void {
  if (useDesktopMode.getState().mode !== "canvas") return;
  requestAnimationFrame(() => {
    const win = find();
    if (!win) return;
    const transform = useCanvasTransform.getState();
    const rect = transform.containerRect;
    transform.focusOnWindow(win, rect?.width ?? window.innerWidth, rect?.height ?? window.innerHeight);
  });
}

/** In Canvas mode, pans to an open window that is not minimized. */
export function panCanvasToShellWindow(id: string): void {
  panCanvasTo(() => {
    const win = useWindowManager.getState().getWindow(id);
    return win && !win.minimized ? win : undefined;
  });
}

/** Opens an app window (a retired app opens nothing); Canvas pans to it. A setup Terminal is never the target. */
export function openShellWindow(name: string, path: string): void {
  if (isRetiredBuiltInAppPath(path)) return;
  useWindowManager.getState().openWindow(name, path, shellWindowXOffset(useDesktopConfigStore.getState().dock));
  panCanvasTo(() => useWindowManager.getState().windows.find((w) => (
    w.path === path && (path !== "__terminal__" || w.terminalPersistence !== "ephemeral")
  )));
}

/** Restores and focuses the app's open window (its own path or a "path:" sub-window), else opens one. */
export function focusOrOpenShellWindow(name: string, path: string): void {
  const manager = useWindowManager.getState();
  const existing = manager.windows.find((w) => path === "__terminal__"
    ? w.path === path && w.terminalPersistence !== "ephemeral"
    : w.path === path || w.path.startsWith(`${path}:`));
  if (!existing) return openShellWindow(name, path);
  manager.restoreAndFocusWindow(existing.id);
  panCanvasToShellWindow(existing.id);
}
