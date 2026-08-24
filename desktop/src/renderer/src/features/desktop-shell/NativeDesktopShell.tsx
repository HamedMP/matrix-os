import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useDesktopSurfaces,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";
import { openChatIndex, openProjectsIndex, openTerminalIndex } from "../mission-control/navigation-roots";
import DesktopIconGrid, { type DesktopDestination } from "./DesktopIconGrid";
import DesktopSurfaceFrame from "./DesktopSurfaceFrame";
import DesktopTaskbar from "./DesktopTaskbar";
import { HOSTED_SHELL_TAB_SPEC } from "../../lib/hosted-shell";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import DesktopBackground from "./DesktopBackground";
import DesktopLaunchpad from "./DesktopLaunchpad";
import { useUi } from "../../stores/ui";

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
  const launcherOpen = useUi((state) => state.appLauncherOpen);
  const setLauncherOpen = useUi((state) => state.setAppLauncherOpen);
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
    reconcileTabs(tabIds, viewport);
  }, [reconcileTabs, tabIds, viewport]);

  const activeSurface = activeTabId ? surfaces[activeTabId] : undefined;
  const activeSurfaceAvailable = activeSurface !== undefined;
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
    reconcileTabs(state.tabs.map((tab) => tab.id), viewport);
    if (state.activeTabId) {
      focusTab(state.activeTabId);
      activateSurface(state.activeTabId);
    }
  }, [activateSurface, focusTab, reconcileTabs, viewport]);

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

  const toggleApps = useCallback(() => setLauncherOpen(!useUi.getState().appLauncherOpen), [setLauncherOpen]);
  const closeApps = useCallback(() => setLauncherOpen(false), [setLauncherOpen]);
  const launchApp = useCallback((tabId: string) => {
    const tabbedWorkspaceOpen = Object.values(useDesktopSurfaces.getState().surfaces)
      .some((surface) => surface.mode === "tab");
    if (tabbedWorkspaceOpen) {
      reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), viewport);
      maximizeToTab(tabId);
      focusTab(tabId);
    }
    setLauncherOpen(false);
  }, [focusTab, maximizeToTab, reconcileTabs, setLauncherOpen, viewport]);

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind === "apps") closeTab(tab.id);
    }
  }, [closeTab, tabs]);

  const destinations = useMemo<DesktopDestination[]>(() => [
    {
      kind: "home",
      label: "Browser",
      open: () => openRoot(() => openTab(HOSTED_SHELL_TAB_SPEC)),
    },
    { kind: "chat", label: "Chat", open: () => openRoot(openChatIndex) },
    { kind: "terminals", label: "Terminal", open: () => openRoot(openTerminalIndex) },
    {
      kind: "files",
      label: "Files",
      open: () => openRoot(() => openTab(FILES_WORKSPACE_TAB_SPEC)),
    },
    {
      kind: "plugins",
      label: "Plugins",
      open: () => openRoot(() => openTab({ kind: "plugins", title: "Plugins" })),
    },
    { kind: "projects", label: "Projects", open: () => openRootAsTab(openProjectsIndex) },
  ], [openRoot, openRootAsTab, openTab]);

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
    minimizeSurface(tabId);
    if (useTabs.getState().activeTabId === tabId) focusFallback(tabId);
  }, [focusFallback, minimizeSurface]);

  const close = useCallback((tab: Tab) => {
    const wasActive = useTabs.getState().activeTabId === tab.id;
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (wasActive) focusFallback(tab.id);
  }, [closeSurface, closeTab, focusFallback]);

  const tabWorkspaceActive = activeSurface?.mode === "tab";

  return (
    <div
      data-native-desktop-shell
      className="absolute inset-x-0 bottom-0 overflow-hidden"
      style={{ top: "var(--titlebar-height)", background: "inherit" }}
    >
      <DesktopBackground />
      {!tabWorkspaceActive ? <DesktopIconGrid destinations={destinations} /> : null}
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
            onFocus={() => activate(tab.id)}
            onClose={() => close(tab)}
            onMinimize={() => minimize(tab.id)}
            onMaximize={() => {
              maximizeToTab(tab.id);
              focusTab(tab.id);
            }}
            onBoundsChange={(bounds) => setSurfaceBounds(tab.id, bounds, viewport)}
          />
        );
      })}
      {launcherMounted ? (
        <DesktopLaunchpad open={launcherOpen} onClose={closeApps} onLaunchTab={launchApp} />
      ) : null}
      <DesktopTaskbar
        tabs={tabs}
        surfaces={surfaces}
        activeTabId={activeTabId}
        onOpenApps={toggleApps}
        launcherOpen={launcherOpen}
        onActivate={activate}
        onMinimize={minimize}
      />
    </div>
  );
}
