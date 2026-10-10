import { useUi } from "../../stores/ui";
import { DesktopViewMenu } from "@matrix-os/ui";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { PanelLeft } from "@renderer/lib/hugeicons";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import DesktopTab from "./DesktopTab";
import DesktopTabGroup from "./DesktopTabGroup";
import SurfaceIcon from "./SurfaceIcon";

const menuOverlay = {
  acquire: () => useUi.getState().acquireRendererOverlay(),
  release: () => useUi.getState().releaseRendererOverlay(),
};

export default function DesktopTabStrip({
  tabs,
  surfaces,
  activeTabId,
  onActivate,
  onRestore,
  onClose,
  workspaceView,
  onShowDesktop,
  onToggleSidebar,
  sidebarOpen,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onRestore: (tabId: string) => void;
  onClose: (tab: Tab) => void;
  workspaceView: "desktop" | "tabs";
  onShowDesktop: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  const mode = useNativeDesktopMode(state => state.mode);
  const setMode = useNativeDesktopMode(state => state.setMode);
  const tabbed = tabs.filter((tab) => surfaces[tab.id]?.mode === "tab");
  return (
    <DesktopTabGroup>
      <DesktopTab
        mode="iconOnly"
        label="Sidebar"
        icon={<PanelLeft />}
        selected={sidebarOpen}
        onClick={onToggleSidebar}
      />
      <DesktopViewMenu overlay={menuOverlay} tab mode={mode} selected={workspaceView === "desktop"} onShowDesktop={onShowDesktop} onModeChange={setMode} />
      {tabbed.map((tab) => {
        const active = workspaceView === "tabs" && tab.id === activeTabId;
        return (
          <DesktopTab
            key={tab.id}
            mode="full"
            label={tab.title}
            icon={<SurfaceIcon tab={tab} size={14} />}
            selected={active}
            canClose
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => onRestore(tab.id)}
            onRestore={() => onRestore(tab.id)}
            onClose={() => onClose(tab)}
          />
        );
      })}
    </DesktopTabGroup>
  );
}
