import { create } from "zustand";
import type { ApiClient } from "../lib/api";
import {
  DEFAULT_TERMINAL_THEME_ID,
  type TerminalThemeId,
} from "../lib/terminal/terminal-settings-types";
import { TERMINAL_THEME_OPTIONS } from "../lib/terminal/terminal-themes";

interface TerminalAppearanceState {
  themeId: TerminalThemeId;
  hydrated: boolean;
  selectionRevision: number;
  loadRevision: number;
  load: (api: TerminalPreferencesApi | null) => Promise<void>;
  setThemeId: (themeId: TerminalThemeId, api: TerminalPreferencesApi | null) => void;
}

type TerminalPreferencesApi = Pick<ApiClient, "get" | "put">;

interface TerminalPreferencesResponse {
  preferences?: { shellThemeId?: unknown };
}

let persistQueue: Promise<void> = Promise.resolve();

function isSelectableTerminalThemeId(value: unknown): value is TerminalThemeId {
  return typeof value === "string" && TERMINAL_THEME_OPTIONS.some((option) => option.id === value);
}

function persist(api: TerminalPreferencesApi | null, themeId: TerminalThemeId): void {
  if (!api) return;
  persistQueue = persistQueue.then(async () => {
    await api.put("/api/terminal/preferences", { shellThemeId: themeId });
  }).catch((error: unknown) => {
    console.warn(
      "[terminal-appearance] persist failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

export const useTerminalAppearance = create<TerminalAppearanceState>()((set, get) => ({
  themeId: DEFAULT_TERMINAL_THEME_ID,
  hydrated: false,
  selectionRevision: 0,
  loadRevision: 0,

  load: async (api) => {
    const loadRevision = get().loadRevision + 1;
    const selectionRevision = get().selectionRevision;
    set({ loadRevision });
    if (!api) {
      set({ hydrated: true });
      return;
    }
    try {
      await persistQueue;
      const result = await api.get<TerminalPreferencesResponse>("/api/terminal/preferences");
      const themeId = isSelectableTerminalThemeId(result.preferences?.shellThemeId)
        ? result.preferences.shellThemeId
        : DEFAULT_TERMINAL_THEME_ID;
      set((state) => ({
        themeId: state.loadRevision === loadRevision && state.selectionRevision === selectionRevision
          ? themeId
          : state.themeId,
        hydrated: true,
      }));
    } catch (error: unknown) {
      console.warn(
        "[terminal-appearance] load failed:",
        error instanceof Error ? error.message : String(error),
      );
      set((state) => state.loadRevision === loadRevision ? { hydrated: true } : {});
    }
  },

  setThemeId: (themeId, api) => {
    if (!api) return;
    set((state) => ({ themeId, selectionRevision: state.selectionRevision + 1 }));
    persist(api, themeId);
  },
}));
