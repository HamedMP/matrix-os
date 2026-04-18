import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

export interface DockConfig {
  position: "left" | "right" | "bottom";
  size: number;
  iconSize: number;
  autoHide: boolean;
}

export interface DockOrder {
  userApps?: string[];
  systemApps?: string[];
}

interface DesktopConfigStore {
  dock: DockConfig;
  pinnedApps: string[];
  dockOrder: DockOrder | undefined;
  setDock: (dock: DockConfig) => void;
  setPinnedApps: (apps: string[]) => void;
  setDockOrder: (order: DockOrder | undefined) => void;
  togglePin: (path: string) => void;
  /** Persist a new section ordering. Accepts a partial update so callers
      can reorder one section without touching the other. */
  reorderDockSection: (
    section: "userApps" | "systemApps",
    paths: string[],
  ) => void;
}

export const useDesktopConfigStore = create<DesktopConfigStore>((set, get) => ({
  dock: { position: "left", size: 44, iconSize: 30, autoHide: false },
  pinnedApps: [],
  dockOrder: undefined,
  setDock: (dock) => set({ dock }),
  setPinnedApps: (pinnedApps) => set({ pinnedApps }),
  setDockOrder: (dockOrder) => set({ dockOrder }),
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
  reorderDockSection: (section, paths) => {
    const current = get().dockOrder ?? {};
    const next: DockOrder = { ...current, [section]: paths };
    set({ dockOrder: next });
    const gatewayUrl = getGatewayUrl();
    fetch(`${gatewayUrl}/api/settings/desktop`).then((res) => {
      if (!res.ok) return;
      return res.json().then((config: Record<string, unknown>) => {
        fetch(`${gatewayUrl}/api/settings/desktop`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...config, dockOrder: next }),
        });
      });
    }).catch(() => {});
  },
}));
