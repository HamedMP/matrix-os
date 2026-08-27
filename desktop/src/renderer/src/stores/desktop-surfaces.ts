import { create } from "zustand";
import { DESKTOP_Z_INDEX } from "../design/layering";

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

export interface DesktopTransition {
  phase: "hiding" | "restoring";
  surfaceIds: string[];
}

const DESKTOP_GAP = 12;
const MIN_WINDOW_WIDTH = 440;
const MIN_WINDOW_HEIGHT = 300;
const MAX_WINDOW_WIDTH = 1_080;
const MAX_WINDOW_HEIGHT = 760;

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
  workspaceView: "desktop" | "tabs";
  desktopHiddenSurfaceIds: string[];
  desktopTransition: DesktopTransition | null;
  reconcileTabs(tabIds: readonly string[], viewport: DesktopViewport, constrainToViewport?: boolean): void;
  showDesktop(): void;
  finishDesktopTransition(): void;
  setWorkspaceView(view: "desktop" | "tabs"): void;
  activateSurface(tabId: string): void;
  focusSurface(tabId: string): void;
  minimizeSurface(tabId: string): void;
  maximizeToTab(tabId: string): void;
  restoreSurface(tabId: string): void;
  restoreAsWindow(tabId: string): void;
  closeSurface(tabId: string): void;
  setSurfaceBounds(tabId: string, bounds: DesktopSurfaceBounds, viewport: DesktopViewport, constrainToViewport?: boolean): void;
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
  if (nextZIndex > DESKTOP_Z_INDEX.nativeDesktopWindowMax) {
    const ordered = Object.values(surfaces).toSorted((left, right) => left.zIndex - right.zIndex);
    const availableRange = DESKTOP_Z_INDEX.nativeDesktopWindowMax
      - DESKTOP_Z_INDEX.nativeDesktopWindowStart;
    const overflow = Math.max(0, ordered.length - availableRange);
    const normalized = Object.fromEntries(ordered.map((candidate, index) => [
      candidate.tabId,
      {
        ...candidate,
        // CSS z-index accepts integers. When more retained surfaces exist than
        // available background layers, older inactive windows may share the
        // bottom layer; the newly focused surface still receives the unique
        // maximum below the taskbar/dialog boundary.
        zIndex: DESKTOP_Z_INDEX.nativeDesktopWindowStart + Math.max(0, index - overflow),
      },
    ]));
    surfaces = normalized;
    nextZIndex = DESKTOP_Z_INDEX.nativeDesktopWindowMax;
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

function syncDesktopHiddenState(
  state: Pick<DesktopSurfacesState, "desktopHiddenSurfaceIds" | "desktopTransition">,
  surfaces: Record<string, DesktopSurface>,
  hiddenSurfaceIds = state.desktopHiddenSurfaceIds,
  transitionSurfaceIds = state.desktopTransition?.surfaceIds,
): Pick<DesktopSurfacesState, "desktopHiddenSurfaceIds" | "desktopTransition"> {
  const desktopHiddenSurfaceIds = hiddenSurfaceIds.filter((tabId) => surfaces[tabId]?.mode === "window");
  const surfaceIds = transitionSurfaceIds?.filter((tabId) => surfaces[tabId]?.mode === "window") ?? [];
  return {
    desktopHiddenSurfaceIds,
    desktopTransition: surfaceIds.length > 0
      ? { ...state.desktopTransition!, surfaceIds }
      : null,
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const useDesktopSurfaces = create<DesktopSurfacesState>()((set) => ({
  surfaces: {},
  nextZIndex: DESKTOP_Z_INDEX.nativeDesktopWindowStart,
  workspaceView: "desktop",
  desktopHiddenSurfaceIds: [],
  desktopTransition: null,

  reconcileTabs: (tabIds, viewport, constrainToViewport = true) => set((state) => {
    const retained = new Set(tabIds);
    const surfaces: Record<string, DesktopSurface> = {};
    let nextZIndex = state.nextZIndex;
    tabIds.forEach((tabId, index) => {
      const existing = state.surfaces[tabId];
      if (existing) {
        surfaces[tabId] = {
          ...existing,
          bounds: constrainToViewport
            ? desktopSurfaceBounds(existing.bounds, viewport)
            : existing.bounds,
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
    const workspaceView = state.workspaceView === "tabs"
      && Object.values(surfaces).some((surface) => surface.mode === "tab")
      ? "tabs"
      : "desktop";
    const syncedHiddenState = syncDesktopHiddenState(state, surfaces);
    const hiddenStateUnchanged = sameStringArray(
      syncedHiddenState.desktopHiddenSurfaceIds,
      state.desktopHiddenSurfaceIds,
    ) && syncedHiddenState.desktopTransition?.phase === state.desktopTransition?.phase
      && sameStringArray(
        syncedHiddenState.desktopTransition?.surfaceIds ?? [],
        state.desktopTransition?.surfaceIds ?? [],
      );
    return unchanged && workspaceView === state.workspaceView && hiddenStateUnchanged
      ? state
      : { surfaces, nextZIndex, workspaceView, ...syncedHiddenState };
  }),

  showDesktop: () => set((state) => {
    if (state.desktopHiddenSurfaceIds.length > 0) {
      return {
        desktopHiddenSurfaceIds: [],
        desktopTransition: { phase: "restoring", surfaceIds: state.desktopHiddenSurfaceIds },
        workspaceView: "desktop",
      };
    }

    const visibleSurfaceIds = Object.values(state.surfaces)
      .filter((surface) => surface.mode === "window")
      .map((surface) => surface.tabId);
    if (visibleSurfaceIds.length === 0) return { workspaceView: "desktop", desktopTransition: null };
    return {
      desktopHiddenSurfaceIds: visibleSurfaceIds,
      desktopTransition: { phase: "hiding", surfaceIds: visibleSurfaceIds },
      workspaceView: "desktop",
    };
  }),

  finishDesktopTransition: () => set({ desktopTransition: null }),

  setWorkspaceView: (view) => set({ workspaceView: view }),

  activateSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    const mode = surface.mode === "minimized"
      ? surface.restoreMode
      : surface.mode === "closed"
        ? "window"
        : surface.mode;
    const focused = nextFocusedState(state, tabId, {
      mode,
      restoreMode: mode === "tab" ? "tab" : "window",
    });
    return {
      ...focused,
      ...syncDesktopHiddenState(
        state,
        focused.surfaces,
        state.desktopHiddenSurfaceIds.filter((id) => id !== tabId),
        state.desktopTransition?.surfaceIds.filter((id) => id !== tabId),
      ),
      workspaceView: mode === "tab" ? "tabs" : "desktop",
    };
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

  maximizeToTab: (tabId) => set((state) => ({
    ...nextFocusedState(state, tabId, {
      mode: "tab",
      restoreMode: "tab",
    }),
    workspaceView: "tabs",
  })),

  restoreSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    const mode = surface.mode === "minimized" ? surface.restoreMode : surface.mode;
    return nextFocusedState(state, tabId, {
      mode: mode === "closed" ? "window" : mode,
    });
  }),

  restoreAsWindow: (tabId) => set((state) => ({
    ...nextFocusedState(state, tabId, {
      mode: "window",
      restoreMode: "window",
    }),
    workspaceView: "desktop",
  })),

  closeSurface: (tabId) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface || surface.mode === "closed") return state;
    const surfaces: Record<string, DesktopSurface> = {
      ...state.surfaces,
      [tabId]: {
        ...surface,
        mode: "closed",
        restoreMode: surface.mode === "tab" ? "tab" : surface.restoreMode,
      },
    };
    return {
      surfaces,
      ...syncDesktopHiddenState(state, surfaces),
      workspaceView: Object.values(surfaces).some((candidate) => candidate.mode === "tab")
        ? state.workspaceView
        : "desktop",
    };
  }),

  setSurfaceBounds: (tabId, bounds, viewport, constrainToViewport = true) => set((state) => {
    const surface = state.surfaces[tabId];
    if (!surface) return state;
    return {
      surfaces: {
        ...state.surfaces,
        [tabId]: {
          ...surface,
          bounds: constrainToViewport ? desktopSurfaceBounds(bounds, viewport) : {
            x: finiteOr(bounds.x, surface.bounds.x),
            y: finiteOr(bounds.y, surface.bounds.y),
            width: clamp(finiteOr(bounds.width, surface.bounds.width), MIN_WINDOW_WIDTH, 16_384),
            height: clamp(finiteOr(bounds.height, surface.bounds.height), MIN_WINDOW_HEIGHT, 16_384),
          },
        },
      },
    };
  }),
}));
