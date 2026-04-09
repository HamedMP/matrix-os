import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { getGatewayUrl } from "@/lib/gateway";

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
  getWindow: (id: string) => AppWindow | undefined;
  getFocusedWindow: () => AppWindow | undefined;
  loadLayout: (saved: LayoutWindow[]) => void;
  setWindows: (updater: AppWindow[] | ((prev: AppWindow[]) => AppWindow[])) => void;
  setApps: (updater: AppEntry[] | ((prev: AppEntry[]) => AppEntry[])) => void;
  cascadeWindows: (startX: number, startY: number, gap: number) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function debouncedSave(state: WindowManagerState) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
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

    for (const path of state.closedPaths) {
      if (!layoutWindows.find((lw) => lw.path === path)) {
        const app = state.apps.find((a) => a.path === path);
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
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windows: layoutWindows }),
    }).catch(() => {});
  }, 500);
}

function createWindowRecord(
  state: WindowManagerState,
  name: string,
  path: string,
  fallbackX: number,
  fallbackY: number,
): AppWindow {
  const saved = state.closedLayouts.get(path);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const defaultWidth = Math.round(Math.min(1200, Math.max(MIN_WIDTH, vw * 0.6)));
  const defaultHeight = Math.round(Math.min(900, Math.max(MIN_HEIGHT, vh * 0.7)));

  return {
    id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: name,
    path,
    x: saved?.x ?? fallbackX,
    y: saved?.y ?? fallbackY,
    width: saved?.width ?? defaultWidth,
    height: saved?.height ?? defaultHeight,
    minimized: false,
    zIndex: state.nextZ,
  };
}

export const useWindowManager = create<WindowManagerState & WindowManagerActions>()(
  subscribeWithSelector((set, get) => ({
    windows: [],
    nextZ: 1,
    closedPaths: new Set<string>(),
    closedLayouts: new Map<string, ClosedLayout>(),
    apps: [],

    openWindow: (name, path, dockXOffset) => {
      set((state) => {
        const existing = state.windows.find((w) => w.path === path);
        if (existing) {
          return {
            windows: state.windows.map((w) =>
              w.path === path
                ? { ...w, minimized: false, zIndex: state.nextZ }
                : w,
            ),
            nextZ: state.nextZ + 1,
          };
        }

        // Compute fallback position to the right of the rightmost visible window
        let fallbackX = dockXOffset + 20;
        let fallbackY = 20;
        const visible = state.windows.filter((w) => !w.minimized);
        if (visible.length > 0) {
          const rightmost = visible.reduce((best, w) =>
            (w.x + w.width) > (best.x + best.width) ? w : best,
          );
          fallbackX = rightmost.x + rightmost.width + 24;
          fallbackY = rightmost.y;
        }

        return {
          windows: [
            ...state.windows,
            createWindowRecord(state, name, path, fallbackX, fallbackY),
          ],
          nextZ: state.nextZ + 1,
        };
      });
    },

    openWindowExclusive: (name, path, dockXOffset, basePath) => {
      set((state) => {
        const keepPath = basePath ?? path;
        const isSameApp = (w: AppWindow) =>
          w.path === keepPath || w.path.startsWith(keepPath + ":");
        const withMinimized = state.windows.map((w) =>
          !isSameApp(w) && !w.minimized ? { ...w, minimized: true } : w,
        );

        const existing = withMinimized.find((w) => w.path === path);
        if (existing) {
          return {
            windows: withMinimized.map((w) =>
              w.path === path
                ? { ...w, minimized: false, zIndex: state.nextZ }
                : w,
            ),
            nextZ: state.nextZ + 1,
          };
        }

        return {
          windows: [
            ...withMinimized,
            createWindowRecord(state, name, path, dockXOffset + 20, 48),
          ],
          nextZ: state.nextZ + 1,
        };
      });
    },

    closeWindow: (id) => {
      set((state) => {
        const win = state.windows.find((w) => w.id === id);
        const newClosed = new Set(state.closedPaths);
        const newLayouts = new Map(state.closedLayouts);
        if (win) {
          newClosed.add(win.path);
          newLayouts.set(win.path, { x: win.x, y: win.y, width: win.width, height: win.height });
        }
        return {
          windows: state.windows.filter((w) => w.id !== id),
          closedPaths: newClosed,
          closedLayouts: newLayouts,
        };
      });
    },

    minimizeWindow: (id) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, minimized: true } : w,
        ),
      }));
    },

    restoreWindow: (id) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, minimized: false } : w,
        ),
      }));
    },

    restoreAndFocusWindow: (id) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, minimized: false, zIndex: state.nextZ } : w,
        ),
        nextZ: state.nextZ + 1,
      }));
    },

    moveWindow: (id, x, y) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, x, y } : w,
        ),
      }));
    },

    resizeWindow: (id, width, height) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id
            ? {
                ...w,
                width: Math.max(MIN_WIDTH, width),
                height: Math.max(MIN_HEIGHT, height),
              }
            : w,
        ),
      }));
    },

    focusWindow: (id) => {
      set((state) => ({
        windows: state.windows.map((w) =>
          w.id === id ? { ...w, zIndex: state.nextZ } : w,
        ),
        nextZ: state.nextZ + 1,
      }));
    },

    getWindow: (id) => {
      return get().windows.find((w) => w.id === id);
    },

    getFocusedWindow: () => {
      const visible = get().windows.filter((w) => !w.minimized);
      if (visible.length === 0) return undefined;
      return visible.reduce((best, w) => (w.zIndex > best.zIndex ? w : best));
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
            newLayouts.set(s.path, { x: s.x, y: s.y, width: s.width, height: s.height });
            continue;
          }
          newWindows.push({
            id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: s.title,
            path: s.path,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            minimized: s.state === "minimized",
            zIndex: z++,
          });
        }

        return {
          windows: [...state.windows.filter((w) => !saved.some((s) => s.path === w.path)), ...newWindows],
          nextZ: z,
          closedPaths: newClosed,
          closedLayouts: newLayouts,
        };
      });
    },

    setWindows: (updater) => {
      set((state) => ({
        windows: typeof updater === "function" ? updater(state.windows) : updater,
      }));
    },

    setApps: (updater) => {
      set((state) => ({
        apps: typeof updater === "function" ? updater(state.apps) : updater,
      }));
    },

    cascadeWindows: (startX, startY, gap) => {
      set((state) => ({
        windows: state.windows.map((w, i) => ({
          ...w,
          x: startX + i * gap,
          y: startY + i * gap,
        })),
      }));
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
