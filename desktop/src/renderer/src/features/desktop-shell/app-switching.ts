// App-switching behaviors behind the Apps keyboard shortcuts. Each reads the
// tab and surface stores directly so it can run from any shortcut dispatcher.
// Focusing an app uses the same sequence as a taskbar click: select the tab,
// then activate its surface, which restores a minimized app and switches the
// workspace view to wherever the app is shown.
import {
  isDesktopSurfaceVisible,
  topmostVisibleDesktopSurfaceId,
  useDesktopSurfaces,
  type DesktopSurface,
} from "../../stores/desktop-surfaces";
import { useClosedApps } from "../../stores/closed-apps";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";

/** Running apps in taskbar order: the fixed Files slot first, then the rest in tab order. */
export function taskbarOrder(
  tabs: readonly Tab[],
  surfaces: Readonly<Record<string, DesktopSurface>>,
): Tab[] {
  const running = tabs.filter((tab) => {
    const mode = surfaces[tab.id]?.mode;
    return mode !== undefined && mode !== "closed";
  });
  const filesTab = running.find((tab) => tab.kind === "files");
  const others = running.filter((tab) => tab.kind !== "files");
  return filesTab ? [filesTab, ...others] : others;
}

function currentTaskbarOrder(): Tab[] {
  return taskbarOrder(useTabs.getState().tabs, useDesktopSurfaces.getState().surfaces);
}

function focusApp(tabId: string): void {
  useTabs.getState().focusTab(tabId);
  useDesktopSurfaces.getState().activateSurface(tabId);
}

function visibleActiveTab(): Tab | undefined {
  const { tabs, activeTabId } = useTabs.getState();
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  if (!tab || !isDesktopSurfaceVisible(tab.id, useDesktopSurfaces.getState())) return undefined;
  return tab;
}

export function cycleApp(direction: 1 | -1): void {
  const surfaces = useDesktopSurfaces.getState().surfaces;
  const candidates = currentTaskbarOrder().filter((tab) => surfaces[tab.id]?.mode !== "minimized");
  if (candidates.length < 2) return;
  const index = candidates.findIndex((tab) => tab.id === useTabs.getState().activeTabId);
  const nextIndex = index === -1
    ? direction === 1 ? 0 : candidates.length - 1
    : (index + direction + candidates.length) % candidates.length;
  focusApp(candidates[nextIndex]!.id);
}

/** Selects the Nth taskbar icon (1-based). Position 1 is always the Files slot. */
export function switchToApp(position: number): void {
  if (!Number.isInteger(position) || position < 1) return;
  const order = currentTaskbarOrder();
  const filesOpen = order[0]?.kind === "files";
  if (position === 1 && !filesOpen) {
    openFilesApp();
    return;
  }
  const target = order[filesOpen ? position - 1 : position - 2];
  if (target) focusApp(target.id);
}

export function minimizeActiveApp(): void {
  const tab = visibleActiveTab();
  if (!tab) return;
  useDesktopSurfaces.getState().minimizeSurface(tab.id);
  const fallbackId = topmostVisibleDesktopSurfaceId(
    useTabs.getState().tabs.map((candidate) => candidate.id),
    useDesktopSurfaces.getState(),
    tab.id,
  );
  if (fallbackId) focusApp(fallbackId);
}

export function toggleActiveAppFullSize(): void {
  const tab = visibleActiveTab();
  if (!tab) return;
  const surfaces = useDesktopSurfaces.getState();
  const mode = surfaces.surfaces[tab.id]?.mode;
  if (mode === "window") surfaces.maximizeToTab(tab.id);
  else if (mode === "tab") surfaces.restoreAsWindow(tab.id);
  else return;
  useTabs.getState().focusTab(tab.id);
}

/**
 * Same as clicking the desktop background: hides every open window and
 * remembers them; the next call restores those that are still open.
 */
export function toggleShowDesktop(): void {
  useDesktopSurfaces.getState().showDesktop();
}

export function openFilesApp(): void {
  const filesTab = currentTaskbarOrder().find((tab) => tab.kind === "files")
    ?? useTabs.getState().tabs.find((tab) => tab.kind === "files");
  if (filesTab) {
    focusApp(filesTab.id);
    return;
  }
  focusApp(useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC));
}

export function reopenClosedApp(): void {
  const spec = useClosedApps.getState().pop();
  if (!spec) return;
  focusApp(useTabs.getState().openTab(spec));
}
