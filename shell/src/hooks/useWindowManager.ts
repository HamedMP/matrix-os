import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { TERMINAL_MIN_WINDOW_HEIGHT, TERMINAL_MIN_WINDOW_WIDTH } from "@/lib/builtin-apps";
import { getGatewayUrl } from "@/lib/gateway";
import { isPreVpsBillingSetupRoute } from "@/lib/pre-vps-shell";
import { SHELL_WINDOW_Z_INDEX_MAX, SHELL_WINDOW_Z_INDEX_START } from "@/lib/shell-layering";
import { useDesktopMode } from "@/stores/desktop-mode";

export interface AppWindow {
  id: string;
  title: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  zIndex: number;
}

export interface LayoutWindow {
  path: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "open" | "minimized" | "closed";
}

export interface AppEntry {
  name: string;
  path: string;
  iconUrl?: string;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const MAX_CLOSED_ENTRIES = 50;
const LAYOUT_FETCH_TIMEOUT_MS = 10_000;

function isTerminalWindowPath(path: string): boolean {
  return path === "__terminal__" || path.startsWith("__terminal__:");
}

function getMinimumWindowSize(path: string): { width: number; height: number } {
  return isTerminalWindowPath(path)
    ? { width: TERMINAL_MIN_WINDOW_WIDTH, height: TERMINAL_MIN_WINDOW_HEIGHT }
    : { width: MIN_WIDTH, height: MIN_HEIGHT };
}

interface ClosedLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowManagerState {
  windows: AppWindow[];
  nextZ: number;
  closedPaths: Set<string>;
  closedLayouts: Map<string, ClosedLayout>;
  apps: AppEntry[];
  focusedWindowId: string | null;
  /** Per-app last-launched timestamp (ms since epoch). Drives the dock's
      default sort when the user hasn't manually reordered. In-memory only
      for now -- survives navigation but not full reload. */
  appLaunchTimes: Record<string, number>;
  fullscreenWindowId: string | null;
}

interface WindowManagerActions {
  openWindow: (name: string, path: string, dockXOffset: number) => void;
  openWindowExclusive: (name: string, path: string, dockXOffset: number, basePath?: string) => void;
  closeWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  restoreAndFocusWindow: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  resizeWindow: (id: string, width: number, height: number) => void;
  focusWindow: (id: string) => void;
  clearFocus: () => void;
  getWindow: (id: string) => AppWindow | undefined;
  getFocusedWindow: () => AppWindow | undefined;
  loadLayout: (saved: LayoutWindow[]) => void;
  setWindows: (updater: AppWindow[] | ((prev: AppWindow[]) => AppWindow[])) => void;
  setApps: (updater: AppEntry[] | ((prev: AppEntry[]) => AppEntry[])) => void;
  cascadeWindows: (startX: number, startY: number, gap: number) => void;
  toggleFullscreen: (id: string) => void;
  exitFullscreen: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let layoutPersistenceArmed = false;

function markUserLayoutMutation(): void {
  layoutPersistenceArmed = true;
}

export function resetWindowManagerLayoutPersistenceForTests(): void {
  layoutPersistenceArmed = false;
  clearTimeout(saveTimer);
  saveTimer = undefined;
}

function debouncedSave(state: WindowManagerState) {
  if (!layoutPersistenceArmed) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (isPreVpsBillingSetupRoute()) return;
    const gatewayUrl = getGatewayUrl();
    const layoutWindows: LayoutWindow[] = state.windows.map((w) => ({
      path: w.path,
      title: w.title,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      state: w.minimized ? ("minimized" as const) : ("open" as const),
    }));

    const layoutPaths = new Set(layoutWindows.map((lw) => lw.path));
    const appsByPath = new Map(state.apps.map((a) => [a.path, a]));
    for (const path of state.closedPaths) {
      if (!layoutPaths.has(path)) {
        const app = appsByPath.get(path);
        layoutWindows.push({
          path,
          title: app?.name ?? path,
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          state: "closed",
        });
      }
    }

    fetch(`${gatewayUrl}/api/layout`, {
      signal: AbortSignal.timeout(LAYOUT_FETCH_TIMEOUT_MS),
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windows: layoutWindows }),
    }).catch((err: unknown) => {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[window-manager] failed to save layout:", err instanceof Error ? err.message : String(err));
      }
    });
  }, 500);
}

function computeDefaultWindowSize(path: string): { width: number; height: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const minSize = getMinimumWindowSize(path);
  return {
    width: Math.round(Math.min(1200, Math.max(minSize.width, vw * 0.6))),
    height: Math.round(Math.min(900, Math.max(minSize.height, vh * 0.7))),
  };
}

// Float a fresh window centered on the viewport (dev/desktop modes). A small
// per-window step keeps stacked opens from perfectly overlapping while staying
// near the middle — never marching off to the right like the canvas cascade.
function centeredWindowPosition(path: string, offsetIndex: number): { x: number; y: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const { width, height } = computeDefaultWindowSize(path);
  const step = (offsetIndex % 6) * 28;
  return {
    x: Math.max(20, Math.round((vw - width) / 2) + step),
    y: Math.max(20, Math.round((vh - height) / 2) + step),
  };
}

function createWindowRecord(
  state: WindowManagerState,
  name: string,
  path: string,
  fallbackX: number,
  fallbackY: number,
): AppWindow {
  const saved = state.closedLayouts.get(path);
  const minSize = getMinimumWindowSize(path);
  const { width: defaultWidth, height: defaultHeight } = computeDefaultWindowSize(path);

  return {
    id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: name,
    path,
    x: saved?.x ?? fallbackX,
    y: saved?.y ?? fallbackY,
    width: Math.max(saved?.width ?? defaultWidth, minSize.width),
    height: Math.max(saved?.height ?? defaultHeight, minSize.height),
    minimized: false,
    zIndex: state.nextZ,
  };
}

function normalizeWindowZOrder(
  windows: AppWindow[],
  nextZ: number,
): { windows: AppWindow[]; nextZ: number } {
  if (nextZ <= SHELL_WINDOW_Z_INDEX_MAX) {
    return { windows, nextZ };
  }

  const ordered = [...windows].sort((left, right) => left.zIndex - right.zIndex);
  const zById = new Map<string, number>();
  ordered.forEach((windowRecord, index) => {
    zById.set(
      windowRecord.id,
      Math.min(SHELL_WINDOW_Z_INDEX_START + index, SHELL_WINDOW_Z_INDEX_MAX),
    );
  });

  return {
    windows: windows.map((windowRecord) => ({
      ...windowRecord,
      zIndex: zById.get(windowRecord.id) ?? SHELL_WINDOW_Z_INDEX_START,
    })),
    nextZ: Math.min(SHELL_WINDOW_Z_INDEX_START + ordered.length, SHELL_WINDOW_Z_INDEX_MAX),
  };
}

export const useWindowManager = create<WindowManagerState & WindowManagerActions>()(
  subscribeWithSelector((set, get) => ({
    windows: [],
    nextZ: 1,
    closedPaths: new Set<string>(),
    closedLayouts: new Map<string, ClosedLayout>(),
    apps: [],
    focusedWindowId: null,
    appLaunchTimes: {},
    fullscreenWindowId: null,

    openWindow: (name, path, dockXOffset) => {
      markUserLayoutMutation();
      set((state) => {
        const zState = normalizeWindowZOrder(state.windows, state.nextZ);
        const launchTimes = { ...state.appLaunchTimes, [path]: Date.now() };
        const existing = zState.windows.find((w) => w.path === path);
        if (existing) {
          return {
            windows: zState.windows.map((w) =>
              w.path === path
                ? { ...w, minimized: false, zIndex: zState.nextZ }
                : w,
            ),
            nextZ: zState.nextZ + 1,
            focusedWindowId: existing.id,
            appLaunchTimes: launchTimes,
          };
        }

        // Position the new window. Canvas pans to the window after it opens, so
        // a spatial cascade to the right of the rightmost window is fine there.
        // Dev/desktop windows float in place, so center them on the viewport
        // instead of marching off to the right of the last one.
        const visible = zState.windows.filter((w) => !w.minimized);
        let fallbackX: number;
        let fallbackY: number;
        if (useDesktopMode.getState().mode === "canvas") {
          fallbackX = dockXOffset + 20;
          fallbackY = 20;
          if (visible.length > 0) {
            const rightmost = visible.reduce((best, w) =>
              (w.x + w.width) > (best.x + best.width) ? w : best,
            );
            fallbackX = rightmost.x + rightmost.width + 24;
            fallbackY = rightmost.y;
          }
        } else {
          const pos = centeredWindowPosition(path, visible.length);
          fallbackX = pos.x;
          fallbackY = pos.y;
        }

        const nextWindow = createWindowRecord(
          { ...state, windows: zState.windows, nextZ: zState.nextZ },
          name,
          path,
          fallbackX,
          fallbackY,
        );
        return {
          windows: [...zState.windows, nextWindow],
          nextZ: zState.nextZ + 1,
          focusedWindowId: nextWindow.id,
          appLaunchTimes: launchTimes,
        };
      });
    },

    openWindowExclusive: (name, path, dockXOffset, basePath) => {
      markUserLayoutMutation();
      set((state) => {
        const zState = normalizeWindowZOrder(state.windows, state.nextZ);
        const keepPath = basePath ?? path;
        const isSameApp = (w: AppWindow) =>
          w.path === keepPath || w.path.startsWith(keepPath + ":");
        const withMinimized = zState.windows.map((w) =>
          !isSameApp(w) && !w.minimized ? { ...w, minimized: true } : w,
        );

        const existing = withMinimized.find((w) => w.path === path);
        if (existing) {
          return {
            windows: withMinimized.map((w) =>
              w.path === path
                ? { ...w, minimized: false, zIndex: zState.nextZ }
                : w,
            ),
            nextZ: zState.nextZ + 1,
            focusedWindowId: existing.id,
          };
        }

        const exclusivePos = useDesktopMode.getState().mode === "canvas"
          ? { x: dockXOffset + 20, y: 48 }
          : centeredWindowPosition(path, 0);
        const nextWindow = createWindowRecord(
          { ...state, windows: zState.windows, nextZ: zState.nextZ },
          name,
          path,
          exclusivePos.x,
          exclusivePos.y,
        );
        return {
          windows: [...withMinimized, nextWindow],
          nextZ: zState.nextZ + 1,
          focusedWindowId: nextWindow.id,
        };
      });
    },

    closeWindow: (id) => {
      markUserLayoutMutation();
      set((state) => {
        const win = state.windows.find((w) => w.id === id);
        const newClosed = new Set(state.closedPaths);
        const newLayouts = new Map(state.closedLayouts);
        if (win) {
          newClosed.add(win.path);
          newLayouts.set(win.path, { x: win.x, y: win.y, width: win.width, height: win.height });
        }
        // Evict oldest entries if over cap
        while (newClosed.size > MAX_CLOSED_ENTRIES) {
          const oldest = newClosed.values().next().value!;
          newClosed.delete(oldest);
          newLayouts.delete(oldest);
        }
        return {
          windows: state.windows.filter((w) => w.id !== id),
          closedPaths: newClosed,
          closedLayouts: newLayouts,
          focusedWindowId: state.focusedWindowId === id ? null : state.focusedWindowId,
          fullscreenWindowId: state.fullscreenWindowId === id ? null : state.fullscreenWindowId,
        };
      });
    },

    minimizeWindow: (id) => {
      markUserLayoutMutation();
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, minimized: true } : w,
        ),
        focusedWindowId: state.focusedWindowId === id ? null : state.focusedWindowId,
      }));
    },

    restoreWindow: (id) => {
      markUserLayoutMutation();
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, minimized: false } : w,
        ),
      }));
    },

    restoreAndFocusWindow: (id) => {
      markUserLayoutMutation();
      set((state) => {
        const zState = normalizeWindowZOrder(state.windows, state.nextZ);
        return {
          windows: zState.windows.map((w) =>
            w.id === id ? { ...w, minimized: false, zIndex: zState.nextZ } : w,
          ),
          nextZ: zState.nextZ + 1,
          focusedWindowId: id,
        };
      });
    },

    moveWindow: (id, x, y) => {
      markUserLayoutMutation();
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, x, y } : w,
        ),
      }));
    },

    resizeWindow: (id, width, height) => {
      markUserLayoutMutation();
      set((state) => ({
        windows: state.windows.map((w) => {
          if (w.id !== id) return w;
          const minSize = getMinimumWindowSize(w.path);
          return {
            ...w,
            width: Math.max(minSize.width, width),
            height: Math.max(minSize.height, height),
          };
        }),
      }));
    },

    focusWindow: (id) => {
      markUserLayoutMutation();
      set((state) => {
        const zState = normalizeWindowZOrder(state.windows, state.nextZ);
        return {
          windows: zState.windows.map((w) =>
            w.id === id ? { ...w, zIndex: zState.nextZ } : w,
          ),
          nextZ: zState.nextZ + 1,
          focusedWindowId: id,
        };
      });
    },

    clearFocus: () => {
      markUserLayoutMutation();
      set({ focusedWindowId: null });
    },

    getWindow: (id) => {
      return get().windows.find((w) => w.id === id);
    },

    getFocusedWindow: () => {
      const { focusedWindowId, windows } = get();
      if (!focusedWindowId) return undefined;
      return windows.find((w) => w.id === focusedWindowId && !w.minimized);
    },

    loadLayout: (saved) => {
      set((state) => {
        const newWindows: AppWindow[] = [];
        const newClosed = new Set(state.closedPaths);
        const newLayouts = new Map(state.closedLayouts);
        let z = state.nextZ;

        for (const s of saved) {
          if (s.state === "closed") {
            newClosed.add(s.path);
            const minSize = getMinimumWindowSize(s.path);
            newLayouts.set(s.path, {
              x: s.x,
              y: s.y,
              width: Math.max(s.width, minSize.width),
              height: Math.max(s.height, minSize.height),
            });
            continue;
          }
          const minSize = getMinimumWindowSize(s.path);
          newWindows.push({
            id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: s.title,
            path: s.path,
            x: s.x,
            y: s.y,
            width: Math.max(s.width, minSize.width),
            height: Math.max(s.height, minSize.height),
            minimized: s.state === "minimized",
            zIndex: z++,
          });
        }

        const windows = [...state.windows.filter((w) => !saved.some((s) => s.path === w.path)), ...newWindows];
        const visibleFocused = windows
          .filter((w) => !w.minimized)
          .reduce<AppWindow | null>((best, w) => !best || w.zIndex > best.zIndex ? w : best, null);

        return {
          windows,
          nextZ: z,
          closedPaths: newClosed,
          closedLayouts: newLayouts,
          focusedWindowId: visibleFocused?.id ?? null,
        };
      });
    },

    setWindows: (updater) => {
      markUserLayoutMutation();
      set((state) => {
        const windows = typeof updater === "function" ? updater(state.windows) : updater;
        const focusedWindow = state.focusedWindowId
          ? windows.find((w) => w.id === state.focusedWindowId && !w.minimized)
          : null;
        return {
          windows,
          focusedWindowId: focusedWindow ? state.focusedWindowId : null,
        };
      });
    },

    setApps: (updater) => {
      set((state) => ({
        apps: typeof updater === "function" ? updater(state.apps) : updater,
      }));
    },

    cascadeWindows: (startX, startY, gap) => {
      markUserLayoutMutation();
      set((state) => ({
        windows: state.windows.map((w, i) => ({
          ...w,
          x: startX + i * gap,
          y: startY + i * gap,
        })),
      }));
    },

    toggleFullscreen: (id) => {
      markUserLayoutMutation();
      set((state) => ({
        fullscreenWindowId: state.fullscreenWindowId === id ? null : id,
        focusedWindowId: id,
      }));
    },

    exitFullscreen: () => {
      markUserLayoutMutation();
      set({ fullscreenWindowId: null });
    },
  })),
);

// Auto-save layout on window/closedPaths changes
useWindowManager.subscribe(
  (state) => ({ windows: state.windows, closedPaths: state.closedPaths, apps: state.apps }),
  (current) => {
    debouncedSave(current as WindowManagerState);
  },
  { equalityFn: (a, b) => a.windows === b.windows && a.closedPaths === b.closedPaths && a.apps === b.apps },
);
