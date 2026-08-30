import { useCallback } from "react";
import {
  topmostVisibleDesktopSurfaceId,
  useDesktopSurfaces,
} from "../../stores/desktop-surfaces";
import { useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useDesktopAppDrawer } from "../../stores/desktop-app-drawer";
import DesktopTabStrip from "./DesktopTabStrip";

export default function DesktopHeaderTabs() {
  const tabs = useTabs((state) => state.tabs);
  const activeTabId = useTabs((state) => state.activeTabId);
  const focusTab = useTabs((state) => state.focusTab);
  const closeTab = useTabs((state) => state.closeTab);
  const surfaces = useDesktopSurfaces((state) => state.surfaces);
  const activateSurface = useDesktopSurfaces((state) => state.activateSurface);
  const restoreAsWindow = useDesktopSurfaces((state) => state.restoreAsWindow);
  const minimizeSurface = useDesktopSurfaces((state) => state.minimizeSurface);
  const closeSurface = useDesktopSurfaces((state) => state.closeSurface);
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const showDesktop = useDesktopSurfaces((state) => state.showDesktop);
  const setWorkspaceView = useDesktopSurfaces((state) => state.setWorkspaceView);
  const requestBackgroundRefresh = useUi((state) => state.requestDesktopBackgroundRefresh);
  const drawerOpen = useDesktopAppDrawer((state) => state.open);
  const toggleDrawer = useDesktopAppDrawer((state) => state.toggle);

  const showDesktopWithRefresh = useCallback(() => {
    showDesktop();
    requestBackgroundRefresh();
  }, [requestBackgroundRefresh, showDesktop]);

  const focusDesktopOrShowDesktop = useCallback(() => {
    if (workspaceView === "desktop") {
      showDesktopWithRefresh();
      return;
    }
    setWorkspaceView("desktop");
    requestBackgroundRefresh();
  }, [requestBackgroundRefresh, setWorkspaceView, showDesktopWithRefresh, workspaceView]);

  const activate = useCallback((tabId: string) => {
    focusTab(tabId);
    activateSurface(tabId);
  }, [activateSurface, focusTab]);

  const focusFallback = useCallback((excludedTabId: string) => {
    const tabIds = useTabs.getState().tabs.map((tab) => tab.id);
    const fallbackId = topmostVisibleDesktopSurfaceId(
      tabIds,
      useDesktopSurfaces.getState(),
      excludedTabId,
    );
    if (fallbackId) activate(fallbackId);
  }, [activate]);

  const close = useCallback((tab: Tab) => {
    const wasActive = useTabs.getState().activeTabId === tab.id;
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (tab.kind === "home" || tab.kind === "browser") requestBackgroundRefresh();
    if (wasActive) focusFallback(tab.id);
  }, [closeSurface, closeTab, focusFallback, requestBackgroundRefresh]);

  const restore = useCallback((tabId: string) => {
    const tab = useTabs.getState().tabs.find((candidate) => candidate.id === tabId);
    restoreAsWindow(tabId);
    focusTab(tabId);
    if (tab?.kind === "home" || tab?.kind === "browser") requestBackgroundRefresh();
  }, [focusTab, requestBackgroundRefresh, restoreAsWindow]);

  return (
    <DesktopTabStrip
      tabs={tabs}
      surfaces={surfaces}
      activeTabId={activeTabId}
      onActivate={activate}
      onRestore={restore}
      onMinimize={(tabId) => {
        minimizeSurface(tabId);
        setWorkspaceView("desktop");
        requestBackgroundRefresh();
      }}
      onClose={close}
      workspaceView={workspaceView}
      onShowDesktop={focusDesktopOrShowDesktop}
      onToggleSidebar={toggleDrawer}
      sidebarOpen={drawerOpen}
    />
  );
}
