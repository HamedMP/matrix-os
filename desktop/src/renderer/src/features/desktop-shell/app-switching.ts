// App actions shared by Electron Desktop's taskbar/window clicks and the Apps
// keyboard shortcuts, so both leave the same app state, durable OS-view save,
// background refresh and analytics. Each reads the stores directly. Side
// effects that need the mounted shell (debounced save, window placement for a
// newly opened app) go through registerDesktopShellEffects; without a mounted
// shell the actions still change app state.
import { nativeBrowserProduct } from "../../../../shared/browser-products";
import { trackDesktopEvent } from "../../lib/desktop-analytics";
import { recordClosedApp, useClosedApps } from "../../stores/closed-apps";
import {
  isDesktopSurfaceVisible,
  topmostVisibleDesktopSurfaceId,
  useDesktopSurfaces,
  type DesktopSurface,
} from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { analyticsKindForTab } from "./desktop-app-analytics";

export interface DesktopShellEffects {
  /** Debounced save of the OS-view state. */
  schedulePersist(): void;
  /** Runs `open`, then places and focuses the newly active app's window. */
  openRoot(open: () => void): void;
}

let shellEffects: DesktopShellEffects | null = null;

/** Called by the mounted shell; returns the matching unregister function. */
export function registerDesktopShellEffects(effects: DesktopShellEffects): () => void {
  shellEffects = effects;
  return () => {
    if (shellEffects === effects) shellEffects = null;
  };
}

function schedulePersist(): void {
  shellEffects?.schedulePersist();
}

/** Native browser views draw over the desktop background, which must repaint when they hide. */
function refreshesBackground(tab: Tab | undefined): boolean {
  return tab?.kind === "home"
    || tab?.kind === "browser"
    || nativeBrowserProduct(tab?.appIdentity ?? "", tab?.slug ?? "") !== null;
}

function findTab(tabId: string): Tab | undefined {
  return useTabs.getState().tabs.find((candidate) => candidate.id === tabId);
}

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

/** Taskbar click: select the app and bring its surface back where it is shown. */
export function focusApp(tabId: string): void {
  useTabs.getState().focusTab(tabId);
  useDesktopSurfaces.getState().activateSurface(tabId);
  trackDesktopEvent({ name: "desktop_app_focused", appKind: analyticsKindForTab(findTab(tabId)) });
  schedulePersist();
}

function focusTopmostVisibleApp(excludedTabId: string): void {
  const fallbackId = topmostVisibleDesktopSurfaceId(
    useTabs.getState().tabs.map((tab) => tab.id),
    useDesktopSurfaces.getState(),
    excludedTabId,
  );
  if (fallbackId) focusApp(fallbackId);
}

export function minimizeApp(tabId: string): void {
  const tab = findTab(tabId);
  useDesktopSurfaces.getState().minimizeSurface(tabId);
  if (useTabs.getState().activeTabId === tabId) focusTopmostVisibleApp(tabId);
  if (refreshesBackground(tab)) useUi.getState().requestDesktopBackgroundRefresh();
  trackDesktopEvent({ name: "desktop_app_minimized", appKind: analyticsKindForTab(tab) });
  schedulePersist();
}

export function closeApp(tab: Tab): void {
  const wasActive = useTabs.getState().activeTabId === tab.id;
  if (tab.closable) useTabs.getState().closeTab(tab.id);
  else useDesktopSurfaces.getState().closeSurface(tab.id);
  recordClosedApp(tab);
  if (wasActive) focusTopmostVisibleApp(tab.id);
  if (refreshesBackground(tab)) useUi.getState().requestDesktopBackgroundRefresh();
  trackDesktopEvent({ name: "desktop_app_closed", appKind: analyticsKindForTab(tab) });
  schedulePersist();
}

export function maximizeApp(tabId: string): void {
  useDesktopSurfaces.getState().maximizeToTab(tabId);
  useTabs.getState().focusTab(tabId);
  const desktopMode = useNativeDesktopMode.getState();
  if (desktopMode.mode === "canvas") desktopMode.setMode("desktop");
  schedulePersist();
}

export function restoreAppAsWindow(tabId: string): void {
  useDesktopSurfaces.getState().restoreAsWindow(tabId);
  useTabs.getState().focusTab(tabId);
  if (refreshesBackground(findTab(tabId))) useUi.getState().requestDesktopBackgroundRefresh();
  schedulePersist();
}

function visibleActiveTab(): Tab | undefined {
  const { activeTabId } = useTabs.getState();
  const tab = activeTabId ? findTab(activeTabId) : undefined;
  if (!tab || !isDesktopSurfaceVisible(tab.id, useDesktopSurfaces.getState())) return undefined;
  return tab;
}

export function cycleApp(direction: 1 | -1): void {
  const order = currentTaskbarOrder();
  const surfaces = useDesktopSurfaces.getState().surfaces;
  const candidates = order.filter((tab) => surfaces[tab.id]?.mode !== "minimized");
  if (candidates.length < 2) return;
  const activeTabId = useTabs.getState().activeTabId;
  const index = candidates.findIndex((tab) => tab.id === activeTabId);
  if (index !== -1) {
    focusApp(candidates[(index + direction + candidates.length) % candidates.length]!.id);
    return;
  }
  // The active app is not a candidate (minimized, or not running): step from
  // its taskbar position so the next app is its neighbour, not the first one.
  const activePosition = order.findIndex((tab) => tab.id === activeTabId);
  const position = (tab: Tab) => order.indexOf(tab);
  const next = direction === 1
    ? candidates.find((tab) => position(tab) > activePosition) ?? candidates[0]
    : candidates.findLast((tab) => activePosition !== -1 && position(tab) < activePosition)
      ?? candidates.at(-1);
  focusApp(next!.id);
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
  if (tab) minimizeApp(tab.id);
}

export function toggleActiveAppFullSize(): void {
  const tab = visibleActiveTab();
  const mode = tab ? useDesktopSurfaces.getState().surfaces[tab.id]?.mode : undefined;
  if (mode === "window") maximizeApp(tab!.id);
  else if (mode === "tab") restoreAppAsWindow(tab!.id);
}

/**
 * Desktop background click: hides every open app and remembers them; the next
 * call restores those still open, including the full-size app that was showing.
 */
export function toggleShowDesktop(): void {
  const restoreTabId = useDesktopSurfaces.getState().desktopRestoreTabId;
  useDesktopSurfaces.getState().showDesktop();
  const surfaces = useDesktopSurfaces.getState();
  if (restoreTabId && surfaces.workspaceView === "tabs" && surfaces.surfaces[restoreTabId]?.mode === "tab") {
    useTabs.getState().focusTab(restoreTabId);
  }
  useUi.getState().requestDesktopBackgroundRefresh();
  trackDesktopEvent({ name: "desktop_shown" });
  schedulePersist();
}

function openAndFocus(open: () => string): void {
  if (shellEffects) {
    shellEffects.openRoot(() => { open(); });
    return;
  }
  focusApp(open());
}

/** Taskbar Apps button and the App Launcher shortcut. */
export function toggleAppLauncher(): void {
  const open = !useUi.getState().appLauncherOpen;
  useUi.getState().setAppLauncherOpen(open);
  trackDesktopEvent({ name: "desktop_launcher_toggled", open });
}

export function openFilesApp(): void {
  const filesTab = currentTaskbarOrder().find((tab) => tab.kind === "files")
    ?? useTabs.getState().tabs.find((tab) => tab.kind === "files");
  if (filesTab) {
    focusApp(filesTab.id);
    return;
  }
  openAndFocus(() => useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC));
}

export function reopenClosedApp(): void {
  const spec = useClosedApps.getState().pop();
  if (!spec) return;
  // An app that cannot be closed keeps its tab, so it is reused. Any other
  // closed tab comes back as its own tab: openTab would fold it into a tab
  // that is still open (a second Chat or Files tab) and replace its content.
  openAndFocus(() => spec.closable === false
    ? useTabs.getState().openTab(spec)
    : useTabs.getState().openTabInstance(spec));
}
