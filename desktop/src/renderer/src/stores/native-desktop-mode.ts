import { create } from "zustand";
import { invoke } from "../lib/operator";

export type NativeDesktopMode = "desktop" | "canvas";

export const MIN_CANVAS_ZOOM = 0.5;
export const MAX_CANVAS_ZOOM = 2;
export const DEFAULT_CANVAS_ZOOM = 1;

interface CanvasTransformPatch {
  panX?: number;
  panY?: number;
  zoom?: number;
}

interface NativeDesktopModeState {
  mode: NativeDesktopMode;
  hydrated: boolean;
  panX: number;
  panY: number;
  zoom: number;
  load: () => Promise<void>;
  setMode: (mode: NativeDesktopMode) => void;
  setCanvasTransform: (patch: CanvasTransformPatch) => void;
  resetCanvasTransform: () => void;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clampZoom(value: number): number {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, value));
}

function persistMode(mode: NativeDesktopMode): void {
  void Promise.resolve()
    .then(() => invoke("state:set", { key: "desktopShell", value: { mode } }))
    .catch((error: unknown) => {
      console.warn(
        "[native-desktop] mode persist failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
}

export const useNativeDesktopMode = create<NativeDesktopModeState>()((set, get) => {
  let modeRevision = 0;
  return {
    mode: "desktop",
    hydrated: false,
    panX: 0,
    panY: 0,
    zoom: DEFAULT_CANVAS_ZOOM,

    load: async () => {
      const startingRevision = modeRevision;
      try {
        const result = await invoke("state:get", { key: "desktopShell" });
        const persisted = result.value as { mode?: unknown } | null;
        const migrateLegacyCanvasMode = persisted?.mode === "canvas";
        set(modeRevision === startingRevision
          ? {
              mode: "desktop",
              hydrated: true,
            }
          : { hydrated: true });
        if (migrateLegacyCanvasMode) persistMode("desktop");
      } catch (error: unknown) {
        console.warn(
          "[native-desktop] mode load failed:",
          error instanceof Error ? error.message : String(error),
        );
        set({ hydrated: true });
      }
    },

    setMode: () => {
      if (get().mode === "desktop") return;
      modeRevision += 1;
      set({ mode: "desktop" });
      persistMode("desktop");
    },

    setCanvasTransform: (patch) => set((state) => ({
      panX: finiteOr(patch.panX, state.panX),
      panY: finiteOr(patch.panY, state.panY),
      zoom: clampZoom(finiteOr(patch.zoom, state.zoom)),
    })),

    resetCanvasTransform: () => set({ panX: 0, panY: 0, zoom: DEFAULT_CANVAS_ZOOM }),
  };
});
