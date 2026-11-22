import { useCallback, useMemo } from "react";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useDesktopAppDrawer } from "../../stores/desktop-app-drawer";
import { useConnection } from "../../stores/connection";
import { useAppsQuery } from "../apps/apps.api";
import { desktopTabsWithLiveAppArtwork } from "./bundled-app-icons";
import DesktopTabStrip from "./DesktopTabStrip";
import { closeApp, focusApp, restoreAppAsWindow, toggleShowDesktop } from "./app-switching";

export default function DesktopHeaderTabs() {
  const tabs = useTabs((state) => state.tabs);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const { data: installedApps = [] } = useAppsQuery();
  const displayTabs = useMemo(
    () => desktopTabsWithLiveAppArtwork(tabs, installedApps, platformHost, runtimeSlot),
    [tabs, installedApps, platformHost, runtimeSlot],
  );
  const activeTabId = useTabs((state) => state.activeTabId);
  const surfaces = useDesktopSurfaces((state) => state.surfaces);
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const setWorkspaceView = useDesktopSurfaces((state) => state.setWorkspaceView);
  const requestBackgroundRefresh = useUi((state) => state.requestDesktopBackgroundRefresh);
  const drawerOpen = useDesktopAppDrawer((state) => state.open);
  const toggleDrawer = useDesktopAppDrawer((state) => state.toggle);

  const focusDesktopOrShowDesktop = useCallback(() => {
    if (workspaceView === "desktop") {
      toggleShowDesktop();
      return;
    }
    setWorkspaceView("desktop");
    requestBackgroundRefresh();
  }, [requestBackgroundRefresh, setWorkspaceView, workspaceView]);

  return (
    <DesktopTabStrip
      tabs={displayTabs}
      surfaces={surfaces}
      activeTabId={activeTabId}
      onActivate={focusApp}
      onRestore={restoreAppAsWindow}
      onClose={closeApp}
      workspaceView={workspaceView}
      onShowDesktop={focusDesktopOrShowDesktop}
      onToggleSidebar={toggleDrawer}
      sidebarOpen={drawerOpen}
    />
  );
}
