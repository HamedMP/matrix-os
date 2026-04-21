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

async function persistDesktopPatch(patch: Record<string, unknown>): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const url = `${gatewayUrl}/api/settings/desktop`;
  const getRes = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!getRes.ok) {
    throw new Error(`GET /api/settings/desktop ${getRes.status}`);
  }
  const config = (await getRes.json()) as Record<string, unknown>;
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ...patch }),
    signal: AbortSignal.timeout(5000),
  });
  if (!putRes.ok) {
    throw new Error(`PUT /api/settings/desktop ${putRes.status}`);
  }
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
    persistDesktopPatch({ pinnedApps: next }).catch((err) => {
      console.warn("[desktop-config] togglePin persist failed:", err instanceof Error ? err.message : String(err));
    });
  },
  reorderDockSection: (section, paths) => {
    const current = get().dockOrder ?? {};
    const next: DockOrder = { ...current, [section]: paths };
    set({ dockOrder: next });
    persistDesktopPatch({ dockOrder: next }).catch((err) => {
      console.warn("[desktop-config] reorderDockSection persist failed:", err instanceof Error ? err.message : String(err));
    });
  },
}));
