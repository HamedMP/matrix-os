import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { isWorkRoute, useTabs } from "../../stores/tabs";

export function useChatMaximized(): boolean {
  const activeTab = useTabs((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  const surfaceMode = useDesktopSurfaces((state) => (activeTab ? state.surfaces[activeTab.id]?.mode : undefined));
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const osView = useNativeDesktopMode((state) => state.mode);
  const chatVisible = isWorkRoute(activeTab, "chat")
    || (isWorkRoute(activeTab, "project") && !!activeTab?.projectSlug);
  return chatVisible && osView === "desktop" && workspaceView === "tabs" && surfaceMode === "tab";
}
