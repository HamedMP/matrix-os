import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  topmostVisibleDesktopSurfaceId,
  useDesktopSurfaces,
  type DesktopViewport,
} from "../../stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "../../stores/tabs";
import { EDITOR_WORKSPACE_TAB_SPEC } from "../editor/desktop-editor-store";
import { openChatIndex, openTerminalIndex } from "../mission-control/navigation-roots";
import DesktopIconGrid, { type DesktopDestination } from "./DesktopIconGrid";
import { FIXED_DESKTOP_APPS, type DesktopAppId } from "./desktop-apps";
import DesktopSurfaceFrame from "./DesktopSurfaceFrame";
import DesktopTaskbar from "./DesktopTaskbar";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import DesktopBackground from "./DesktopBackground";
import DesktopLaunchpad from "./DesktopLaunchpad";
import { useUi } from "../../stores/ui";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import DesktopWorkspacePlane from "./DesktopWorkspacePlane";
import DesktopBackgroundMenu from "./DesktopBackgroundMenu";
import DesktopAppDrawer from "./DesktopAppDrawer";
import { useDesktopAppDrawer } from "../../stores/desktop-app-drawer";
import { useConnection } from "../../stores/connection";
import { defaultDesktopIcons, useDesktopIcons } from "../../stores/desktop-icons";
import { trackDesktopEvent } from "../../lib/desktop-analytics";
import { appIconUrl, useApps } from "../../stores/apps";
import { LayoutGrid } from "@renderer/lib/hugeicons";
import { useCreateAppRequest } from "../../stores/create-app-request";
import {
  createNativeOsViewLayoutMemory,
  transitionNativeOsViewLayout,
} from "./native-os-view-layout-memory";

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
  const normalizeLegacyTabs = useTabs((state) => state.normalizeLegacyTabs);
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
  const desktopTransition = useDesktopSurfaces((state) => state.desktopTransition);
  const desktopHiddenSurfaceIds = useDesktopSurfaces((state) => state.desktopHiddenSurfaceIds);
  const finishDesktopTransition = useDesktopSurfaces((state) => state.finishDesktopTransition);
  const launcherOpen = useUi((state) => state.appLauncherOpen);
  const setLauncherOpen = useUi((state) => state.setAppLauncherOpen);
  const requestBackgroundRefresh = useUi((state) => state.requestDesktopBackgroundRefresh);
  const desktopMode = useNativeDesktopMode((state) => state.mode);
  const desktopModeHydrated = useNativeDesktopMode((state) => state.hydrated);
  const canvasZoom = useNativeDesktopMode((state) => state.zoom);
  const canvasPanX = useNativeDesktopMode((state) => state.panX);
  const canvasPanY = useNativeDesktopMode((state) => state.panY);
  const setDesktopMode = useNativeDesktopMode((state) => state.setMode);
  const drawerOpen = useDesktopAppDrawer((state) => state.open);
  const setDrawerOpen = useDesktopAppDrawer((state) => state.setOpen);
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const installedApps = useApps((state) => state.apps);
  const desktopIcons = useDesktopIcons((state) => state.icons);
  const primeDesktopIcons = useDesktopIcons((state) => state.prime);
  const moveDesktopIcon = useDesktopIcons((state) => state.move);
  const removeDesktopIcon = useDesktopIcons((state) => state.remove);
  const addDesktopIcon = useDesktopIcons((state) => state.add);
  // Mount on first use, then retain the image nodes so reopening can reuse the
  // browser's decoded icon resources instead of issuing another request set.
  const [launcherMounted, setLauncherMounted] = useState(launcherOpen);
  const [viewport, setViewport] = useState(currentViewport);
  const previousDesktopModeRef = useRef(desktopMode);
  const osViewLayoutsRef = useRef(createNativeOsViewLayoutMemory());
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const defaultIconLayout = useMemo(
    () => defaultDesktopIcons(FIXED_DESKTOP_APPS.map((app) => app.path)),
    [],
  );

  useLayoutEffect(() => {
    primeDesktopIcons(defaultIconLayout);
  }, [defaultIconLayout, primeDesktopIcons]);

  const effectiveDesktopIcons = desktopIcons.length > 0 || useDesktopIcons.getState().loaded
    ? desktopIcons
    : defaultIconLayout;

  useEffect(() => {
    const resize = () => setViewport(currentViewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (launcherOpen) setLauncherMounted(true);
  }, [launcherOpen]);

  useEffect(() => {
    normalizeLegacyTabs();
  }, [normalizeLegacyTabs]);

  useEffect(() => {
    if (!desktopModeHydrated) return;
    const previousMode = previousDesktopModeRef.current;
    if (previousMode !== desktopMode) {
      const transition = transitionNativeOsViewLayout(
        osViewLayoutsRef.current,
        previousMode,
        desktopMode,
        useDesktopSurfaces.getState().surfaces,
      );
      osViewLayoutsRef.current = transition.memory;
      useDesktopSurfaces.setState({ surfaces: transition.surfaces });
      previousDesktopModeRef.current = desktopMode;
    }
    reconcileTabs(tabIds, viewport, desktopMode !== "canvas");
  }, [desktopMode, desktopModeHydrated, reconcileTabs, tabIds, viewport]);

  useEffect(() => {
    if (!desktopTransition) return;
    const timer = window.setTimeout(() => finishDesktopTransition(), 280);
    return () => window.clearTimeout(timer);
  }, [desktopTransition, finishDesktopTransition]);

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
    const tab = useTabs.getState().tabs.find((candidate) => candidate.id === tabId);
    trackDesktopEvent({ name: "desktop_app_focused", appKind: tab?.kind });
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

  const closeApps = useCallback(() => setLauncherOpen(false), [setLauncherOpen]);
  const showDesktopWithRefresh = useCallback(() => {
    useDesktopSurfaces.getState().showDesktop();
    requestBackgroundRefresh();
    trackDesktopEvent({ name: "desktop_shown" });
  }, [requestBackgroundRefresh]);
  const toggleApps = useCallback(
    () => {
      const open = !useUi.getState().appLauncherOpen;
      setLauncherOpen(open);
      trackDesktopEvent({ name: "desktop_launcher_toggled", open });
    },
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
      work: () => openRoot(openChatIndex),
      terminal: () => openRoot(openTerminalIndex),
      files: () => openRoot(() => openTab(FILES_WORKSPACE_TAB_SPEC)),
      editor: () => openRoot(() => openTab(EDITOR_WORKSPACE_TAB_SPEC)),
      vscode: () => openRoot(() => openTab({
        kind: "vscode",
        title: "VS Code",
        closable: false,
        icon: FIXED_DESKTOP_APPS.find((app) => app.id === "vscode")?.iconUrl,
      })),
      settings: () => openRoot(() => {
        useUi.getState().requestSettingsSection("account");
        openTab({ kind: "settings", title: "Settings" });
      }),
      plugins: () => openRoot(() => {
        useUi.getState().requestSettingsSection("services");
        openTab({ kind: "settings", title: "Plugins" });
      }),
      browser: () => openRoot(() => openTab({ kind: "browser", title: "Browser" })),
      notes: () => openRoot(() => openTab({ kind: "notes", title: "Notes" })),
      whiteboard: () => openRoot(() => openTab({ kind: "app", slug: "whiteboard", title: "Whiteboard" })),
    };
    const fixed = FIXED_DESKTOP_APPS.map((app) => ({
      ...app,
      open: () => {
        trackDesktopEvent({ name: "desktop_app_opened", appKind: app.id });
        openers[app.id]();
      },
    }));
    const fixedPaths = new Set(fixed.map((app) => app.path));
    const generated: DesktopDestination[] = installedApps.flatMap((app) => {
      if (!app.path || fixedPaths.has(app.path)) return [];
      return [{
        id: `installed:${app.slug}`,
        path: app.path,
        kind: "app",
        icon: LayoutGrid,
        iconUrl: appIconUrl(platformHost, app.slug, runtimeSlot) ?? undefined,
        name: app.name,
        color: "var(--bg-surface)",
        open: () => {
          trackDesktopEvent({ name: "desktop_app_opened", appKind: "app" });
          openRoot(() => openTab({ kind: "app", slug: app.slug, title: app.name, ...(app.appIdentity ? { appIdentity: app.appIdentity } : {}) }));
        },
      }];
    });
    return [...fixed, ...generated];
  }, [installedApps, openRoot, openTab, platformHost, runtimeSlot]);

  const openDesktopApp = useCallback((app: (typeof FIXED_DESKTOP_APPS)[number]) => {
    destinations.find((destination) => destination.id === app.id)?.open();
    setLauncherOpen(false);
  }, [destinations, setLauncherOpen]);

  const createApp = useCallback(() => {
    useCreateAppRequest.getState().requestDraft();
    destinations.find((destination) => destination.id === "work")?.open();
    setLauncherOpen(false);
  }, [destinations, setLauncherOpen]);

  const moveIcon = useCallback((path: string, x: number, y: number) => {
    if (api) {
      void moveDesktopIcon(path, x, y, api);
      trackDesktopEvent({ name: "desktop_icon_moved" });
    }
  }, [api, moveDesktopIcon]);

  const removeIcon = useCallback((path: string) => {
    if (api) {
      void removeDesktopIcon(path, api);
      trackDesktopEvent({ name: "desktop_icon_removed" });
    }
  }, [api, removeDesktopIcon]);

  const addIcon = useCallback((path: string) => {
    if (api) void addDesktopIcon(path, api);
  }, [addDesktopIcon, api]);

  const focusFallback = useCallback((excludedTabId: string) => {
    const tabIds = useTabs.getState().tabs.map((tab) => tab.id);
    const fallbackId = topmostVisibleDesktopSurfaceId(
      tabIds,
      useDesktopSurfaces.getState(),
      excludedTabId,
    );
    if (fallbackId) activate(fallbackId);
  }, [activate]);

  const minimize = useCallback((tabId: string) => {
    const minimizedTab = useTabs.getState().tabs.find((tab) => tab.id === tabId);
    minimizeSurface(tabId);
    if (useTabs.getState().activeTabId === tabId) focusFallback(tabId);
    if (minimizedTab?.kind === "home" || minimizedTab?.kind === "browser") {
      requestBackgroundRefresh();
    }
    trackDesktopEvent({ name: "desktop_app_minimized", appKind: minimizedTab?.kind });
  }, [focusFallback, minimizeSurface, requestBackgroundRefresh]);

  const close = useCallback((tab: Tab) => {
    const wasActive = useTabs.getState().activeTabId === tab.id;
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (wasActive) focusFallback(tab.id);
    if (tab.kind === "home" || tab.kind === "browser") requestBackgroundRefresh();
    trackDesktopEvent({ name: "desktop_app_closed", appKind: tab.kind });
  }, [closeSurface, closeTab, focusFallback, requestBackgroundRefresh]);

  const activateFromDrawer = useCallback((tabId: string) => {
    activate(tabId);
    setDrawerOpen(false);
  }, [activate, setDrawerOpen]);

  const closeFromDrawer = useCallback((tab: Tab) => {
    close(tab);
  }, [close]);

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
      <DesktopAppDrawer
        open={drawerOpen}
        tabs={tabs}
        surfaces={surfaces}
        onClose={() => setDrawerOpen(false)}
        onActivate={activateFromDrawer}
        onCloseTab={closeFromDrawer}
      />
      {desktopModeHydrated ? (
        <>
      {desktopMode === "desktop" && !tabWorkspaceActive ? (
        <DesktopIconGrid destinations={destinations} placements={effectiveDesktopIcons} onMove={moveIcon} onRemove={removeIcon} />
      ) : null}
      <DesktopBackgroundMenu>
        <DesktopWorkspacePlane mode={desktopMode} onBackgroundClick={showDesktopWithRefresh}>
          {desktopMode === "canvas" ? <DesktopIconGrid destinations={destinations} placements={effectiveDesktopIcons} onMove={moveIcon} onRemove={removeIcon} /> : null}
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
              desktopTransition={desktopTransition}
              desktopHiddenSurfaceIds={desktopHiddenSurfaceIds}
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
        <DesktopLaunchpad
          open={launcherOpen}
          onClose={closeApps}
          onLaunchTab={launchApp}
          onCreateApp={createApp}
          onOpenDesktopApp={openDesktopApp}
          onAddToDesktop={addIcon}
          osViewMode={desktopMode}
          onSwitchOsView={setDesktopMode}
        />
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
