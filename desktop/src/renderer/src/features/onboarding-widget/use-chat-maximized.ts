import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { isWorkRoute, useTabs } from "../../stores/tabs";

export function useChatMaximized(): boolean {
  const activeChatId = useTabs((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return isWorkRoute(active, "chat") ? state.activeTabId : null;
  });
  const surfaceMode = useDesktopSurfaces((state) => (activeChatId ? state.surfaces[activeChatId]?.mode : undefined));
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const osView = useNativeDesktopMode((state) => state.mode);
  return osView === "desktop" && workspaceView === "tabs" && surfaceMode === "tab";
}
