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

interface WindowManagerState {
  windows: AppWindow[];
  nextZ: number;
  closedPaths: Set<string>;
  apps: AppEntry[];
}

interface WindowManagerActions {
  openWindow: (name: string, path: string, dockXOffset: number) => void;
  closeWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  resizeWindow: (id: string, width: number, height: number) => void;
  focusWindow: (id: string) => void;
  getWindow: (id: string) => AppWindow | undefined;
  loadLayout: (saved: LayoutWindow[]) => void;
  setWindows: (updater: AppWindow[] | ((prev: AppWindow[]) => AppWindow[])) => void;
  setApps: (updater: AppEntry[] | ((prev: AppEntry[]) => AppEntry[])) => void;
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

export const useWindowManager = create<WindowManagerState & WindowManagerActions>()(
  subscribeWithSelector((set, get) => ({
    windows: [],
    nextZ: 1,
    closedPaths: new Set<string>(),
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
        return {
          windows: [
            ...state.windows,
            {
              id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              title: name,
              path,
              x: dockXOffset + state.windows.length * 30,
              y: 20 + state.windows.length * 30,
              width: 640,
              height: 480,
              minimized: false,
              zIndex: state.nextZ,
            },
          ],
          nextZ: state.nextZ + 1,
        };
      });
    },

    closeWindow: (id) => {
      set((state) => {
        const win = state.windows.find((w) => w.id === id);
        const newClosed = new Set(state.closedPaths);
        if (win) newClosed.add(win.path);
        return {
          windows: state.windows.filter((w) => w.id !== id),
          closedPaths: newClosed,
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

    loadLayout: (saved) => {
      set((state) => {
        const newWindows: AppWindow[] = [];
        const newClosed = new Set(state.closedPaths);
        let z = state.nextZ;

        for (const s of saved) {
          if (s.state === "closed") {
            newClosed.add(s.path);
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
  })),
);

// Auto-save layout on window/closedPaths changes
useWindowManager.subscribe(
  (state) => ({ windows: state.windows, closedPaths: state.closedPaths, apps: state.apps }),
  (current) => {
    debouncedSave(current as WindowManagerState);
  },
  { equalityFn: (a, b) => a.windows === b.windows && a.closedPaths === b.closedPaths },
);
