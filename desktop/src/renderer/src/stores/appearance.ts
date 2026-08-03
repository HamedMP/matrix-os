// Appearance state: the unified theme id plus the light/dark/system mode, and
// the app-wide zoom factor. Persisted through the bounded state IPC under the
// existing "appearance" key ({ theme } stays the mode for backwards
// compatibility with stored values).
//
// Zoom single source of truth: this store owns the persisted factor. It
// applies it once per boot via app:set-zoom after hydration; main only applies
// factors to webContents and reports menu-driven steps back through
// app:zoom-changed, which this store mirrors and persists.
import { create } from "zustand";
import { applyUnifiedTheme, resolveThemeMode, type ThemeMode } from "../design/themes/apply";
import { DEFAULT_THEME_ID, isThemeId } from "../design/themes";
import { invoke, onEvent } from "../lib/operator";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
export const DEFAULT_ZOOM = 1;
export const ZOOM_STEP = 0.1;

function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_ZOOM;
  const rounded = Math.round(factor * 10) / 10;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded));
}

interface AppearanceState {
  mode: ThemeMode;
  themeId: string;
  zoom: number;
  hydrated: boolean;
  load: () => Promise<void>;
  setMode: (mode: ThemeMode) => void;
  setThemeId: (themeId: string) => void;
  setZoom: (factor: number) => void;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

function persist(mode: ThemeMode, themeId: string, zoom: number): void {
  void invoke("state:set", { key: "appearance", value: { theme: mode, themeId, zoom } }).catch((err: unknown) => {
    console.warn("[appearance] persist failed:", err instanceof Error ? err.message : String(err));
  });
}

function applyZoomFactor(zoom: number): void {
  void invoke("app:set-zoom", { factor: zoom }).catch((err: unknown) => {
    console.warn("[appearance] zoom apply failed:", err instanceof Error ? err.message : String(err));
  });
}

export const useAppearance = create<AppearanceState>()((set, get) => {
  let unsubscribeZoom: (() => void) | null = null;

  // Menu/shortcut zoom steps land here; main already applied the factor, so
  // only mirror and persist — re-invoking app:set-zoom would be redundant.
  function wireZoomEvents(): void {
    unsubscribeZoom?.();
    unsubscribeZoom = onEvent("app:zoom-changed", ({ factor }) => {
      const zoom = clampZoom(factor);
      set({ zoom });
      persist(get().mode, get().themeId, zoom);
    });
  }

  return {
    mode: "system",
    themeId: DEFAULT_THEME_ID,
    zoom: DEFAULT_ZOOM,
    hydrated: false,

    load: async () => {
      let zoom = get().zoom;
      try {
        const result = await invoke("state:get", { key: "appearance" });
        const value = result.value as { theme?: unknown; themeId?: unknown; zoom?: unknown } | null;
        const mode = isThemeMode(value?.theme) ? value.theme : get().mode;
        const themeId = isThemeId(value?.themeId) ? value.themeId : get().themeId;
        zoom = typeof value?.zoom === "number" ? clampZoom(value.zoom) : zoom;
        set({ mode, themeId, zoom, hydrated: true });
        applyUnifiedTheme(themeId, mode);
      } catch (err: unknown) {
        console.warn("[appearance] load failed:", err instanceof Error ? err.message : String(err));
        set({ hydrated: true });
        applyUnifiedTheme(get().themeId, get().mode);
      }
      // Apply the persisted factor once per boot, then start mirroring
      // menu-driven zoom changes.
      applyZoomFactor(zoom);
      wireZoomEvents();
    },

    setMode: (mode) => {
      set({ mode });
      applyUnifiedTheme(get().themeId, mode);
      persist(mode, get().themeId, get().zoom);
    },

    setThemeId: (themeId) => {
      if (!isThemeId(themeId)) return;
      set({ themeId });
      applyUnifiedTheme(themeId, get().mode);
      persist(get().mode, themeId, get().zoom);
    },

    setZoom: (factor) => {
      const zoom = clampZoom(factor);
      set({ zoom });
      applyZoomFactor(zoom);
      persist(get().mode, get().themeId, zoom);
    },
  };
});

/** The resolved dark/light variant currently in effect. */
export function resolvedAppearanceMode(): "dark" | "light" {
  return resolveThemeMode(useAppearance.getState().mode);
}
