import { useCallback } from "react";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs, type Tab } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import DesktopTabStrip from "./DesktopTabStrip";

export default function DesktopHeaderTabs() {
  const tabs = useTabs((state) => state.tabs);
  const activeTabId = useTabs((state) => state.activeTabId);
  const focusTab = useTabs((state) => state.focusTab);
  const closeTab = useTabs((state) => state.closeTab);
  const surfaces = useDesktopSurfaces((state) => state.surfaces);
  const activateSurface = useDesktopSurfaces((state) => state.activateSurface);
  const restoreAsWindow = useDesktopSurfaces((state) => state.restoreAsWindow);
  const closeSurface = useDesktopSurfaces((state) => state.closeSurface);
  const setLauncherOpen = useUi((state) => state.setAppLauncherOpen);

  const activate = useCallback((tabId: string) => {
    focusTab(tabId);
    activateSurface(tabId);
  }, [activateSurface, focusTab]);

  const focusFallback = useCallback((excludedTabId: string) => {
    let fallback: Tab | undefined;
    let fallbackZIndex = Number.NEGATIVE_INFINITY;
    for (const tab of useTabs.getState().tabs) {
      const surface = useDesktopSurfaces.getState().surfaces[tab.id];
      if (
        tab.id !== excludedTabId
        && surface
        && surface.mode !== "minimized"
        && surface.mode !== "closed"
        && surface.zIndex > fallbackZIndex
      ) {
        fallback = tab;
        fallbackZIndex = surface.zIndex;
      }
    }
    if (fallback) activate(fallback.id);
  }, [activate]);

  const close = useCallback((tab: Tab) => {
    const wasActive = useTabs.getState().activeTabId === tab.id;
    if (tab.closable) closeTab(tab.id);
    else closeSurface(tab.id);
    if (wasActive) focusFallback(tab.id);
  }, [closeSurface, closeTab, focusFallback]);

  return (
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
      onOpenApps={() => setLauncherOpen(true)}
    />
  );
}
