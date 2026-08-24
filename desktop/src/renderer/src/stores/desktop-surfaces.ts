import { create } from "zustand";

export type DesktopSurfaceMode = "window" | "tab" | "minimized" | "closed";
export type DesktopSurfaceRestoreMode = "window" | "tab";

export interface DesktopViewport {
  width: number;
  height: number;
}

export interface DesktopSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopSurface {
  tabId: string;
  mode: DesktopSurfaceMode;
  restoreMode: DesktopSurfaceRestoreMode;
  bounds: DesktopSurfaceBounds;
  zIndex: number;
}

const DESKTOP_GAP = 12;
const MIN_WINDOW_WIDTH = 440;
const MIN_WINDOW_HEIGHT = 300;
const MAX_WINDOW_WIDTH = 1_080;
const MAX_WINDOW_HEIGHT = 760;
const WINDOW_Z_START = 10;
const WINDOW_Z_MAX = 80;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function desktopSurfaceBounds(
  bounds: DesktopSurfaceBounds,
  viewport: DesktopViewport,
): DesktopSurfaceBounds {
  const availableWidth = Math.max(1, finiteOr(viewport.width, 1) - DESKTOP_GAP * 2);
  const availableHeight = Math.max(1, finiteOr(viewport.height, 1) - DESKTOP_GAP * 2);
  const minimumWidth = Math.min(MIN_WINDOW_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIN_WINDOW_HEIGHT, availableHeight);
  const width = clamp(finiteOr(bounds.width, minimumWidth), minimumWidth, availableWidth);
  const height = clamp(finiteOr(bounds.height, minimumHeight), minimumHeight, availableHeight);
  return {
    x: clamp(finiteOr(bounds.x, DESKTOP_GAP), DESKTOP_GAP, viewport.width - DESKTOP_GAP - width),
    y: clamp(finiteOr(bounds.y, DESKTOP_GAP), DESKTOP_GAP, viewport.height - DESKTOP_GAP - height),
    width,
    height,
  };
}

export function defaultDesktopSurfaceBounds(
  index: number,
  viewport: DesktopViewport,
): DesktopSurfaceBounds {
  const availableWidth = Math.max(1, viewport.width - DESKTOP_GAP * 2);
  const availableHeight = Math.max(1, viewport.height - DESKTOP_GAP * 2);
  const width = Math.min(MAX_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, Math.round(viewport.width * 0.68)), availableWidth);
  const height = Math.min(MAX_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, Math.round(viewport.height * 0.74)), availableHeight);
  const offset = (index % 6) * 26;
  return desktopSurfaceBounds({
    x: Math.round((viewport.width - width) / 2) + offset,
    y: Math.round((viewport.height - height) / 2) + offset,
    width,
    height,
  }, viewport);
}

interface DesktopSurfacesState {
  surfaces: Record<string, DesktopSurface>;
  nextZIndex: number;
  reconcileTabs(tabIds: readonly string[], viewport: DesktopViewport): void;
  activateSurface(tabId: string): void;
  focusSurface(tabId: string): void;
  minimizeSurface(tabId: string): void;
  maximizeToTab(tabId: string): void;
  restoreSurface(tabId: string): void;
  restoreAsWindow(tabId: string): void;
  closeSurface(tabId: string): void;
  setSurfaceBounds(tabId: string, bounds: DesktopSurfaceBounds, viewport: DesktopViewport): void;
}

function nextFocusedState(
  state: Pick<DesktopSurfacesState, "surfaces" | "nextZIndex">,
  tabId: string,
  patch: Partial<DesktopSurface> = {},
): Pick<DesktopSurfacesState, "surfaces" | "nextZIndex"> {
  const surface = state.surfaces[tabId];
  if (!surface) return state;

  let surfaces = state.surfaces;
  let nextZIndex = state.nextZIndex;
  if (nextZIndex > WINDOW_Z_MAX) {
    const ordered = Object.values(surfaces).toSorted((left, right) => left.zIndex - right.zIndex);
    const normalized = Object.fromEntries(ordered.map((candidate, index) => [
      candidate.tabId,
      { ...candidate, zIndex: WINDOW_Z_START + index },
    ]));
    surfaces = normalized;
    nextZIndex = WINDOW_Z_START + ordered.length;
  }

  return {
    surfaces: {
      ...surfaces,
      [tabId]: {
        ...surfaces[tabId]!,
        ...patch,
        zIndex: nextZIndex,
      },
    },
    nextZIndex: nextZIndex + 1,
  };
}

export const useDesktopSurfaces = create<DesktopSurfacesState>()((set) => ({
  surfaces: {},
  nextZIndex: WINDOW_Z_START,

  reconcileTabs: (tabIds, viewport) => set((state) => {
    const retained = new Set(tabIds);
    const surfaces: Record<string, DesktopSurface> = {};
    let nextZIndex = state.nextZIndex;
    tabIds.forEach((tabId, index) => {
      const existing = state.surfaces[tabId];
      if (existing) {
        surfaces[tabId] = {
          ...existing,
          bounds: desktopSurfaceBounds(existing.bounds, viewport),
        };
        return;
      }
      surfaces[tabId] = {
        tabId,
        mode: "window",
        restoreMode: "window",
        bounds: defaultDesktopSurfaceBounds(index, viewport),
        zIndex: nextZIndex,
      };
      nextZIndex += 1;
    });

    const unchanged = Object.keys(state.surfaces).length === retained.size
      && Object.keys(state.surfaces).every((tabId) => retained.has(tabId))
      && Object.values(surfaces).every((surface) => {
        const previous = state.surfaces[surface.tabId];
        return previous
          && previous.mode === surface.mode
          && previous.restoreMode === surface.restoreMode
          && previous.zIndex === surface.zIndex
          && previous.bounds.x === surface.bounds.x
          && previous.bounds.y === surface.bounds.y
          && previous.bounds.width === surface.bounds.width
          && previous.bounds.height === surface.bounds.height;
      });
    return unchanged ? state : { surfaces, nextZIndex };
  }),

  activateSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    const mode = surface.mode === "minimized"
      ? surface.restoreMode
      : surface.mode === "closed"
        ? "window"
        : surface.mode;
    return nextFocusedState(state, tabId, {
      mode,
      restoreMode: mode === "tab" ? "tab" : "window",
    });
  }),

  focusSurface: (tabId) => set((state) => nextFocusedState(state, tabId)),

  minimizeSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface || surface.mode === "minimized" || surface.mode === "closed") return state;
    return {
      surfaces: {
        ...state.surfaces,
        [tabId]: {
          ...surface,
          mode: "minimized",
          restoreMode: surface.mode === "tab" ? "tab" : "window",
        },
      },
    };
  }),

  maximizeToTab: (tabId) => set((state) => nextFocusedState(state, tabId, {
    mode: "tab",
    restoreMode: "tab",
  })),

  restoreSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    const mode = surface.mode === "minimized" ? surface.restoreMode : surface.mode;
    return nextFocusedState(state, tabId, {
      mode: mode === "closed" ? "window" : mode,
    });
  }),

  restoreAsWindow: (tabId) => set((state) => nextFocusedState(state, tabId, {
    mode: "window",
    restoreMode: "window",
  })),

  closeSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface || surface.mode === "closed") return state;
    return {
      surfaces: {
        ...state.surfaces,
        [tabId]: {
          ...surface,
          mode: "closed",
          restoreMode: surface.mode === "tab" ? "tab" : surface.restoreMode,
        },
      },
    };
  }),

  setSurfaceBounds: (tabId, bounds, viewport) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    return {
      surfaces: {
        ...state.surfaces,
        [tabId]: {
          ...surface,
          bounds: desktopSurfaceBounds(bounds, viewport),
        },
      },
    };
  }),
}));
