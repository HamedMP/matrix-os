import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useDesktopSurfaces,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";
import { openChatIndex, openProjectsIndex, openTerminalIndex } from "../mission-control/navigation-roots";
import DesktopIconGrid, { type DesktopDestination } from "./DesktopIconGrid";
import DesktopSurfaceFrame from "./DesktopSurfaceFrame";
import DesktopTabStrip from "./DesktopTabStrip";
import DesktopTaskbar from "./DesktopTaskbar";
import { HOSTED_SHELL_TAB_SPEC } from "../../lib/hosted-shell";

const TASKBAR_RESERVED_HEIGHT = 86;

function currentViewport(): DesktopViewport {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight - TASKBAR_RESERVED_HEIGHT - 38),
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
  const [viewport, setViewport] = useState(currentViewport);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  useEffect(() => {
    const resize = () => setViewport(currentViewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

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

  const openApps = useCallback(() => {
    openTab({ kind: "apps", title: "Apps" });
    reconcileAndActivateCurrent();
  }, [openTab, reconcileAndActivateCurrent]);

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
    { kind: "apps", label: "Apps", open: openApps },
    {
      kind: "plugins",
      label: "Plugins",
      open: () => openRoot(() => openTab({ kind: "plugins", title: "Plugins" })),
    },
    { kind: "projects", label: "Projects", open: () => openRoot(openProjectsIndex) },
  ], [openApps, openRoot, openTab]);

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
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (useTabs.getState().activeTabId === tab.id) focusFallback(tab.id);
  }, [closeSurface, closeTab, focusFallback]);

  const tabWorkspaceActive = activeSurface?.mode === "tab";

  return (
    <div
      data-native-desktop-shell
      className="absolute inset-x-0 bottom-0 overflow-hidden"
      style={{ top: "var(--titlebar-height)", background: "inherit" }}
    >
      {!tabWorkspaceActive ? <DesktopIconGrid destinations={destinations} /> : null}
      {tabWorkspaceActive ? (
        <DesktopTabStrip
          tabs={tabs}
          surfaces={surfaces}
          activeTabId={activeTabId}
          onActivate={activate}
          onRestore={(tabId) => {
            restoreAsWindow(tabId);
            focusTab(tabId);
          }}
          onClose={close}
          onOpenApps={openApps}
        />
      ) : null}
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
      <DesktopTaskbar
        tabs={tabs}
        surfaces={surfaces}
        activeTabId={activeTabId}
        onOpenApps={openApps}
        onActivate={activate}
        onMinimize={minimize}
      />
    </div>
  );
}
