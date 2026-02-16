import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

export interface DockConfig {
  position: "left" | "right" | "bottom";
  size: number;
  iconSize: number;
  autoHide: boolean;
}

interface DesktopConfigStore {
  dock: DockConfig;
  pinnedApps: string[];
  setDock: (dock: DockConfig) => void;
  setPinnedApps: (apps: string[]) => void;
  togglePin: (path: string) => void;
}

export const useDesktopConfigStore = create<DesktopConfigStore>((set, get) => ({
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: [],
  setDock: (dock) => set({ dock }),
  setPinnedApps: (pinnedApps) => set({ pinnedApps }),
  togglePin: (path) => {
    const current = get().pinnedApps ?? [];
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    set({ pinnedApps: next });
    const gatewayUrl = getGatewayUrl();
    fetch(`${gatewayUrl}/api/settings/desktop`).then((res) => {
      if (!res.ok) return;
      return res.json().then((config: Record<string, unknown>) => {
        fetch(`${gatewayUrl}/api/settings/desktop`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...config, pinnedApps: next }),
        });
      });
    }).catch(() => {});
  },
}));
