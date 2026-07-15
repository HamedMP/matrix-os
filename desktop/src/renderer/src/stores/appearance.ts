// Appearance state: the unified theme id plus the light/dark/system mode.
// Persisted through the bounded state IPC under the existing "appearance" key
// ({ theme } stays the mode for backwards compatibility with stored values).
import { create } from "zustand";
import { applyUnifiedTheme, resolveThemeMode, type ThemeMode } from "../design/themes/apply";
import { DEFAULT_THEME_ID, isThemeId } from "../design/themes";
import { invoke } from "../lib/operator";

interface AppearanceState {
  mode: ThemeMode;
  themeId: string;
  hydrated: boolean;
  load: () => Promise<void>;
  setMode: (mode: ThemeMode) => void;
  setThemeId: (themeId: string) => void;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

function persist(mode: ThemeMode, themeId: string): void {
  void invoke("state:set", { key: "appearance", value: { theme: mode, themeId } }).catch((err: unknown) => {
    console.warn("[appearance] persist failed:", err instanceof Error ? err.message : String(err));
  });
}

export const useAppearance = create<AppearanceState>()((set, get) => ({
  mode: "system",
  themeId: DEFAULT_THEME_ID,
  hydrated: false,

  load: async () => {
    try {
      const result = await invoke("state:get", { key: "appearance" });
      const value = result.value as { theme?: unknown; themeId?: unknown } | null;
      const mode = isThemeMode(value?.theme) ? value.theme : get().mode;
      const themeId = isThemeId(value?.themeId) ? value.themeId : get().themeId;
      set({ mode, themeId, hydrated: true });
      applyUnifiedTheme(themeId, mode);
    } catch (err: unknown) {
      console.warn("[appearance] load failed:", err instanceof Error ? err.message : String(err));
      set({ hydrated: true });
      applyUnifiedTheme(get().themeId, get().mode);
    }
  },

  setMode: (mode) => {
    set({ mode });
    applyUnifiedTheme(get().themeId, mode);
    persist(mode, get().themeId);
  },

  setThemeId: (themeId) => {
    if (!isThemeId(themeId)) return;
    set({ themeId });
    applyUnifiedTheme(themeId, get().mode);
    persist(get().mode, themeId);
  },
}));

/** The resolved dark/light variant currently in effect. */
export function resolvedAppearanceMode(): "dark" | "light" {
  return resolveThemeMode(useAppearance.getState().mode);
}
