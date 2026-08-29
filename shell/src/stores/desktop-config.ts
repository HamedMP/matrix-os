import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";
import { DEFAULT_PINNED_APPS } from "@/lib/builtin-apps";

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

export interface DesktopIconPlacement {
  path: string;
  x: number;
  y: number;
}

const MAX_DESKTOP_ICONS = 512;
const MAX_DESKTOP_COORDINATE = 16_384;

interface DesktopConfigStore {
  dock: DockConfig;
  pinnedApps: string[];
  dockOrder: DockOrder | undefined;
  desktopIcons: DesktopIconPlacement[] | undefined;
  setDock: (dock: DockConfig) => void;
  setPinnedApps: (apps: string[]) => void;
  setDockOrder: (order: DockOrder | undefined) => void;
  setDesktopIcons: (icons: DesktopIconPlacement[] | undefined) => void;
  moveDesktopIcon: (path: string, x: number, y: number) => void;
  removeDesktopIcon: (path: string) => void;
  addDesktopIcon: (path: string) => void;
  togglePin: (path: string) => void;
  /** Persist a new section ordering. Accepts a partial update so callers
      can reorder one section without touching the other. */
  reorderDockSection: (
    section: "userApps" | "systemApps",
    paths: string[],
  ) => void;
}

let desktopPersistQueue: Promise<void> = Promise.resolve();
let desktopIconMutationSequence = 0;
let desktopIconStateEpoch = 0;
let confirmedDesktopIcons: DesktopIconPlacement[] | undefined;

function copyDesktopIcons(icons: readonly DesktopIconPlacement[] | undefined): DesktopIconPlacement[] | undefined {
  return icons?.map((icon) => ({ ...icon }));
}

function persistDesktopPatch(patch: Record<string, unknown>): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const url = `${gatewayUrl}/api/settings/desktop`;
  const snapshot = JSON.stringify(patch);
  const write = async () => {
    if (getGatewayUrl() !== gatewayUrl) return;
    const putRes = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: snapshot,
      signal: AbortSignal.timeout(5000),
    });
    if (!putRes.ok) throw new Error(`PATCH /api/settings/desktop ${putRes.status}`);
  };
  const pending = desktopPersistQueue.then(write, write);
  desktopPersistQueue = pending.catch((error: unknown) => {
    console.warn("[desktop-config] persist queue recovered:", error instanceof Error ? error.name : typeof error);
  });
  return pending;
}

function applyDesktopIconMutation(
  icons: DesktopIconPlacement[],
  set: (partial: Partial<DesktopConfigStore>) => void,
): void {
  const sequence = ++desktopIconMutationSequence;
  const epoch = desktopIconStateEpoch;
  const snapshot = copyDesktopIcons(icons) ?? [];
  set({ desktopIcons: snapshot });
  void persistDesktopPatch({ desktopIcons: snapshot }).then(() => {
    if (epoch === desktopIconStateEpoch && sequence <= desktopIconMutationSequence) {
      confirmedDesktopIcons = copyDesktopIcons(snapshot);
    }
  }).catch((error: unknown) => {
    console.warn("[desktop-config] desktopIcons persist failed:", error instanceof Error ? error.name : typeof error);
    if (epoch === desktopIconStateEpoch && sequence === desktopIconMutationSequence) {
      set({ desktopIcons: copyDesktopIcons(confirmedDesktopIcons) });
    }
  });
}

export const useDesktopConfigStore = create<DesktopConfigStore>((set, get) => ({
  dock: { position: "left", size: 44, iconSize: 30, autoHide: false },
  pinnedApps: [...DEFAULT_PINNED_APPS],
  dockOrder: undefined,
  desktopIcons: undefined,
  setDock: (dock) => set({ dock }),
  setPinnedApps: (pinnedApps) => set({ pinnedApps }),
  setDockOrder: (dockOrder) => set({ dockOrder }),
  setDesktopIcons: (desktopIcons) => {
    desktopIconMutationSequence += 1;
    desktopIconStateEpoch += 1;
    confirmedDesktopIcons = copyDesktopIcons(desktopIcons);
    set({ desktopIcons: copyDesktopIcons(desktopIcons) });
  },
  moveDesktopIcon: (path, x, y) => {
    const current = get().desktopIcons ?? [];
    const next = current.map((icon) => icon.path === path ? {
      ...icon,
      x: Math.max(0, Math.min(MAX_DESKTOP_COORDINATE, Math.round(x))),
      y: Math.max(0, Math.min(MAX_DESKTOP_COORDINATE, Math.round(y))),
    } : icon);
    applyDesktopIconMutation(next, set);
  },
  removeDesktopIcon: (path) => {
    const next = (get().desktopIcons ?? []).filter((icon) => icon.path !== path);
    applyDesktopIconMutation(next, set);
  },
  addDesktopIcon: (path) => {
    const current = get().desktopIcons ?? [];
    if (!path || path.length > 2048 || current.length >= MAX_DESKTOP_ICONS || current.some((icon) => icon.path === path)) return;
    const occupied = new Set(current.map((icon) => `${icon.x}:${icon.y}`));
    let slot = { x: 20, y: 20 };
    for (let index = 0; index < MAX_DESKTOP_ICONS; index += 1) {
      const candidate = { x: 20 + (index % 2) * 88, y: 20 + Math.floor(index / 2) * 92 };
      if (!occupied.has(`${candidate.x}:${candidate.y}`)) {
        slot = candidate;
        break;
      }
    }
    const next = [...current, { path, ...slot }];
    applyDesktopIconMutation(next, set);
  },
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
