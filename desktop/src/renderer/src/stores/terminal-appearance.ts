import { create } from "zustand";
import { invoke } from "../lib/operator";
import {
  DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID,
  isDesktopTerminalAppThemeId,
  type DesktopTerminalAppThemeId,
} from "../features/terminal/terminal-app-theme";

interface TerminalAppearanceState {
  appThemeId: DesktopTerminalAppThemeId;
  hydrated: boolean;
  selectionRevision: number;
  load: () => Promise<void>;
  setAppThemeId: (appThemeId: DesktopTerminalAppThemeId) => void;
}

function storedThemeId(value: unknown): DesktopTerminalAppThemeId | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as { appThemeId?: unknown; mode?: unknown };
  if (isDesktopTerminalAppThemeId(stored.appThemeId)) return stored.appThemeId;
  if (stored.mode === "dark") return "matrix-dark";
  if (stored.mode === "light") return "light";
  return null;
}

function persist(appThemeId: DesktopTerminalAppThemeId): void {
  void invoke("state:set", {
    key: "terminalAppearance",
    value: { appThemeId },
  }).catch((error: unknown) => {
    console.warn(
      "[terminal-appearance] persist failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

export const useTerminalAppearance = create<TerminalAppearanceState>()((set) => ({
  appThemeId: DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID,
  hydrated: false,
  selectionRevision: 0,

  load: async () => {
    try {
      const result = await invoke("state:get", { key: "terminalAppearance" });
      const appThemeId = storedThemeId(result.value);
      set((state) => ({
        appThemeId: state.selectionRevision > 0
          ? state.appThemeId
          : appThemeId ?? DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID,
        hydrated: true,
      }));
    } catch (error: unknown) {
      console.warn(
        "[terminal-appearance] load failed:",
        error instanceof Error ? error.message : String(error),
      );
      set((state) => ({
        appThemeId: state.selectionRevision > 0
          ? state.appThemeId
          : DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID,
        hydrated: true,
      }));
    }
  },

  setAppThemeId: (appThemeId) => {
    set((state) => ({ appThemeId, selectionRevision: state.selectionRevision + 1 }));
    persist(appThemeId);
  },
}));
