import { Monitor, PanelLeft } from "lucide-react";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import DesktopTab from "./DesktopTab";
import DesktopTabGroup from "./DesktopTabGroup";
import SurfaceIcon from "./SurfaceIcon";

export default function DesktopTabStrip({
  tabs,
  surfaces,
  activeTabId,
  onActivate,
  onRestore,
  onMinimize,
  onClose,
  workspaceView,
  onShowDesktop,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onRestore: (tabId: string) => void;
  onMinimize: (tabId: string) => void;
  onClose: (tab: Tab) => void;
  workspaceView: "desktop" | "tabs";
  onShowDesktop: () => void;
}) {
  const tabbed = tabs.filter((tab) => surfaces[tab.id]?.mode === "tab");
  return (
    <DesktopTabGroup>
      <DesktopTab
        mode="iconOnly"
        label="Sidebar"
        icon={<PanelLeft />}
        onClick={() => {}}
      />
      <DesktopTab
        mode="iconOnly"
        label="Desktop"
        icon={<Monitor />}
        selected={workspaceView === "desktop"}
        onClick={onShowDesktop}
      />
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
            onMinimize={() => onMinimize(tab.id)}
            onClose={() => onClose(tab)}
          />
        );
      })}
    </DesktopTabGroup>
  );
}
