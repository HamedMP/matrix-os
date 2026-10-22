import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { DEFAULT_PROJECT_VIEW, useProjectView } from "../../stores/project-view";
import { isWorkRoute, useTabs } from "../../stores/tabs";

export function useChatMaximized(): boolean {
  const activeTab = useTabs((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  const projectView = useProjectView((state) => activeTab?.projectSlug
    ? state.entries[activeTab.projectSlug]?.view ?? DEFAULT_PROJECT_VIEW
    : null);
  const surfaceMode = useDesktopSurfaces((state) => (activeTab ? state.surfaces[activeTab.id]?.mode : undefined));
  const workspaceView = useDesktopSurfaces((state) => state.workspaceView);
  const osView = useNativeDesktopMode((state) => state.mode);
  const chatVisible = isWorkRoute(activeTab, "chat")
    || (isWorkRoute(activeTab, "project") && projectView === "chats");
  return chatVisible && osView === "desktop" && workspaceView === "tabs" && surfaceMode === "tab";
}
