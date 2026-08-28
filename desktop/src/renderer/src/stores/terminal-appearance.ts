import { create } from "zustand";
import { invoke } from "../lib/operator";
import {
  DEFAULT_TERMINAL_THEME_ID,
  type TerminalThemeId,
} from "../lib/terminal/terminal-settings-types";
import { TERMINAL_THEME_OPTIONS } from "../lib/terminal/terminal-themes";

interface TerminalAppearanceState {
  themeId: TerminalThemeId;
  hydrated: boolean;
  selectionRevision: number;
  load: () => Promise<void>;
  setThemeId: (themeId: TerminalThemeId) => void;
}

function isSelectableTerminalThemeId(value: unknown): value is TerminalThemeId {
  return typeof value === "string" && TERMINAL_THEME_OPTIONS.some((option) => option.id === value);
}

function storedThemeId(value: unknown): TerminalThemeId | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as { themeId?: unknown; appThemeId?: unknown; mode?: unknown };
  if (isSelectableTerminalThemeId(stored.themeId)) return stored.themeId;
  if (isSelectableTerminalThemeId(stored.appThemeId)) return stored.appThemeId;
  if (stored.mode === "light") return "light";
  if (stored.mode === "dark") return "matrix-dark";
  return null;
}

function persist(themeId: TerminalThemeId): void {
  void invoke("state:set", {
    key: "terminalAppearance",
    value: { themeId },
  }).catch((error: unknown) => {
    console.warn(
      "[terminal-appearance] persist failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

export const useTerminalAppearance = create<TerminalAppearanceState>()((set) => ({
  themeId: DEFAULT_TERMINAL_THEME_ID,
  hydrated: false,
  selectionRevision: 0,

  load: async () => {
    try {
      const result = await invoke("state:get", { key: "terminalAppearance" });
      const themeId = storedThemeId(result.value);
      set((state) => ({
        themeId: state.selectionRevision > 0
          ? state.themeId
          : themeId ?? DEFAULT_TERMINAL_THEME_ID,
        hydrated: true,
      }));
    } catch (error: unknown) {
      console.warn(
        "[terminal-appearance] load failed:",
        error instanceof Error ? error.message : String(error),
      );
      set((state) => ({
        themeId: state.selectionRevision > 0
          ? state.themeId
          : DEFAULT_TERMINAL_THEME_ID,
        hydrated: true,
      }));
    }
  },

  setThemeId: (themeId) => {
    set((state) => ({ themeId, selectionRevision: state.selectionRevision + 1 }));
    persist(themeId);
  },
}));
