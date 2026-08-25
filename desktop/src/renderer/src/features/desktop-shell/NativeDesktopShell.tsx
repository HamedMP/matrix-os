import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useDesktopSurfaces,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";
import { openChatIndex, openProjectsIndex, openTerminalIndex } from "../mission-control/navigation-roots";
import DesktopIconGrid, { type DesktopDestination } from "./DesktopIconGrid";
import { FIXED_DESKTOP_APPS, type DesktopAppId } from "./desktop-apps";
import DesktopSurfaceFrame from "./DesktopSurfaceFrame";
import DesktopTaskbar from "./DesktopTaskbar";
import { HOSTED_SHELL_TAB_SPEC } from "../../lib/hosted-shell";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import DesktopBackground from "./DesktopBackground";
import DesktopLaunchpad from "./DesktopLaunchpad";
import { useUi } from "../../stores/ui";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import DesktopWorkspacePlane from "./DesktopWorkspacePlane";
import DesktopBackgroundMenu from "./DesktopBackgroundMenu";

function currentViewport(): DesktopViewport {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(
      1,
      window.innerHeight
        - NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight
        - NATIVE_DESKTOP_LAYOUT.tabStripHeight,
    ),
  };
}

export default function NativeDesktopShell({ overlayOpen }: { overlayOpen: boolean }) {
  const tabs = useTabs((state) => state.tabs);
  const activeTabId = useTabs((state) => state.activeTabId);
  const openTab = useTabs((state) => state.openTab);
  const focusTab = useTabs((state) => state.focusTab);
  const closeTab = useTabs((state) => state.closeTab);
  const surfaces = useDesktopSurfaces((state) => state.surfaces);
  const reconcileTabs = useDesktopSurfaces((state) => state.reconcileTabs);
  const activateSurface = useDesktopSurfaces((state) => state.activateSurface);
  const minimizeSurface = useDesktopSurfaces((state) => state.minimizeSurface);
  const maximizeToTab = useDesktopSurfaces((state) => state.maximizeToTab);
  const restoreAsWindow = useDesktopSurfaces((state) => state.restoreAsWindow);
  const closeSurface = useDesktopSurfaces((state) => state.closeSurface);
  const setSurfaceBounds = useDesktopSurfaces((state) => state.setSurfaceBounds);
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const launcherOpen = useUi((state) => state.appLauncherOpen);
  const setLauncherOpen = useUi((state) => state.setAppLauncherOpen);
  const requestBackgroundRefresh = useUi((state) => state.requestDesktopBackgroundRefresh);
  const desktopMode = useNativeDesktopMode((state) => state.mode);
  const desktopModeHydrated = useNativeDesktopMode((state) => state.hydrated);
  const canvasZoom = useNativeDesktopMode((state) => state.zoom);
  const canvasPanX = useNativeDesktopMode((state) => state.panX);
  const canvasPanY = useNativeDesktopMode((state) => state.panY);
  const setDesktopMode = useNativeDesktopMode((state) => state.setMode);
  // Mount on first use, then retain the image nodes so reopening can reuse the
  // browser's decoded icon resources instead of issuing another request set.
  const [launcherMounted, setLauncherMounted] = useState(launcherOpen);
  const [viewport, setViewport] = useState(currentViewport);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  useEffect(() => {
    const resize = () => setViewport(currentViewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (launcherOpen) setLauncherMounted(true);
  }, [launcherOpen]);

  useEffect(() => {
    if (!desktopModeHydrated) return;
    reconcileTabs(tabIds, viewport, desktopMode !== "canvas");
  }, [desktopMode, desktopModeHydrated, reconcileTabs, tabIds, viewport]);

  const activeSurface = activeTabId ? surfaces[activeTabId] : undefined;
  const activeSurfaceAvailable = activeSurface !== undefined && activeSurface.mode !== "closed";
  useEffect(() => {
    if (!activeTabId || !activeSurfaceAvailable) return;
    activateSurface(activeTabId);
    // Only react to active identity or a surface appearing. Bounds/z-index
    // updates must not recursively focus the same surface while it is dragged.
  }, [activateSurface, activeSurfaceAvailable, activeTabId]);

  const activate = useCallback((tabId: string) => {
    focusTab(tabId);
    activateSurface(tabId);
  }, [activateSurface, focusTab]);

  const reconcileAndActivateCurrent = useCallback(() => {
    const state = useTabs.getState();
    reconcileTabs(state.tabs.map((tab) => tab.id), viewport, desktopMode !== "canvas");
    if (state.activeTabId) {
      focusTab(state.activeTabId);
      activateSurface(state.activeTabId);
    }
  }, [activateSurface, desktopMode, focusTab, reconcileTabs, viewport]);

  const openRoot = useCallback((open: () => void) => {
    open();
    reconcileAndActivateCurrent();
  }, [reconcileAndActivateCurrent]);

  const openRootAsTab = useCallback((open: () => void) => {
    openRoot(open);
    const tabId = useTabs.getState().activeTabId;
    if (!tabId) return;
    maximizeToTab(tabId);
    focusTab(tabId);
  }, [focusTab, maximizeToTab, openRoot]);

  const closeApps = useCallback(() => setLauncherOpen(false), [setLauncherOpen]);
  const toggleApps = useCallback(
    () => setLauncherOpen(!useUi.getState().appLauncherOpen),
    [setLauncherOpen],
  );
  const launchApp = useCallback((tabId: string) => {
    const tabbedWorkspaceOpen = desktopMode === "desktop"
      && workspaceView === "tabs"
      && Object.values(useDesktopSurfaces.getState().surfaces)
      .some((surface) => surface.mode === "tab");
    if (tabbedWorkspaceOpen) {
      reconcileTabs(
        useTabs.getState().tabs.map((tab) => tab.id),
        viewport,
        true,
      );
      maximizeToTab(tabId);
      focusTab(tabId);
    }
    setLauncherOpen(false);
  }, [desktopMode, focusTab, maximizeToTab, reconcileTabs, setLauncherOpen, viewport, workspaceView]);

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind === "apps") closeTab(tab.id);
    }
  }, [closeTab, tabs]);

  const destinations = useMemo<DesktopDestination[]>(() => {
    const openers: Record<DesktopAppId, () => void> = {
      browser: () => openRoot(() => openTab(HOSTED_SHELL_TAB_SPEC)),
      chat: () => openRoot(openChatIndex),
      terminal: () => openRoot(openTerminalIndex),
      files: () => openRoot(() => openTab(FILES_WORKSPACE_TAB_SPEC)),
      plugins: () => openRoot(() => openTab({ kind: "plugins", title: "Plugins" })),
      settings: () => openRoot(() => openTab({ kind: "settings", title: "Settings" })),
      projects: () => desktopMode === "canvas"
        ? openRoot(openProjectsIndex)
        : openRootAsTab(openProjectsIndex),
    };
    return FIXED_DESKTOP_APPS.map((app) => ({ ...app, open: openers[app.id] }));
  }, [desktopMode, openRoot, openRootAsTab, openTab]);

  const focusFallback = useCallback((excludedTabId: string) => {
    const surfaceState = useDesktopSurfaces.getState().surfaces;
    let fallback: Tab | undefined;
    let fallbackZIndex = Number.NEGATIVE_INFINITY;
    for (const tab of useTabs.getState().tabs) {
      const surface = surfaceState[tab.id];
      if (
        tab.id !== excludedTabId &&
        surface &&
        surface.mode !== "minimized" &&
        surface.mode !== "closed" &&
        surface.zIndex > fallbackZIndex
      ) {
        fallback = tab;
        fallbackZIndex = surface.zIndex;
      }
    }
    if (fallback) activate(fallback.id);
  }, [activate]);

  const minimize = useCallback((tabId: string) => {
    const minimizedTab = useTabs.getState().tabs.find((tab) => tab.id === tabId);
    minimizeSurface(tabId);
    if (useTabs.getState().activeTabId === tabId) focusFallback(tabId);
    if (minimizedTab?.kind === "home") requestBackgroundRefresh();
  }, [focusFallback, minimizeSurface, requestBackgroundRefresh]);

  const close = useCallback((tab: Tab) => {
    const wasActive = useTabs.getState().activeTabId === tab.id;
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (wasActive) focusFallback(tab.id);
    if (tab.kind === "home") requestBackgroundRefresh();
  }, [closeSurface, closeTab, focusFallback, requestBackgroundRefresh]);

  const tabWorkspaceActive = desktopMode === "desktop"
    && workspaceView === "tabs"
    && activeSurface?.mode === "tab";

  return (
    <div
      data-native-desktop-shell
      className="absolute inset-x-0 bottom-0 overflow-hidden"
      style={{ top: "var(--titlebar-height)", background: "inherit" }}
    >
      <DesktopBackground />
      {desktopModeHydrated ? (
        <>
      {desktopMode === "desktop" && !tabWorkspaceActive ? (
        <DesktopIconGrid destinations={destinations} />
      ) : null}
      <DesktopBackgroundMenu>
        <DesktopWorkspacePlane mode={desktopMode}>
          {desktopMode === "canvas" ? <DesktopIconGrid destinations={destinations} /> : null}
          {tabs.map((tab) => {
          const surface = surfaces[tab.id];
          if (!surface) return null;
          return (
            <DesktopSurfaceFrame
              key={tab.id}
              tab={tab}
              surface={surface}
              active={tab.id === activeTabId}
              tabWorkspaceActive={tabWorkspaceActive}
              overlayOpen={overlayOpen}
              presentation={desktopMode}
              interactionScale={desktopMode === "canvas" ? canvasZoom : 1}
              workspaceRevision={desktopMode === "canvas" ? `${canvasPanX}:${canvasPanY}:${canvasZoom}` : "desktop"}
              onFocus={() => activate(tab.id)}
              onClose={() => close(tab)}
              onMinimize={() => minimize(tab.id)}
              onMaximize={() => {
                maximizeToTab(tab.id);
                focusTab(tab.id);
                if (desktopMode === "canvas") setDesktopMode("desktop");
              }}
              onBoundsChange={(bounds) => setSurfaceBounds(tab.id, bounds, viewport, desktopMode !== "canvas")}
            />
          );
          })}
        </DesktopWorkspacePlane>
      </DesktopBackgroundMenu>
      {launcherMounted ? (
        <DesktopLaunchpad open={launcherOpen} onClose={closeApps} onLaunchTab={launchApp} />
      ) : null}
      {!tabWorkspaceActive ? (
        <DesktopTaskbar
          tabs={tabs}
          surfaces={surfaces}
          activeTabId={activeTabId}
          onOpenApps={toggleApps}
          onOpenFiles={() => openRoot(() => openTab(FILES_WORKSPACE_TAB_SPEC))}
          launcherOpen={launcherOpen}
          onActivate={activate}
        />
      ) : null}
        </>
      ) : null}
    </div>
  );
}
