import { create } from "zustand";
import { invoke } from "../lib/operator";

export type TerminalAppearanceMode = "dark" | "light";

interface TerminalAppearanceState {
  mode: TerminalAppearanceMode;
  hydrated: boolean;
  selectionRevision: number;
  load: () => Promise<void>;
  setMode: (mode: TerminalAppearanceMode) => void;
}

const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearanceMode = "dark";

function isTerminalAppearanceMode(value: unknown): value is TerminalAppearanceMode {
  return value === "dark" || value === "light";
}

function persist(mode: TerminalAppearanceMode): void {
  void invoke("state:set", {
    key: "terminalAppearance",
    value: { mode },
  }).catch((error: unknown) => {
    console.warn(
      "[terminal-appearance] persist failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

export const useTerminalAppearance = create<TerminalAppearanceState>()((set) => ({
  mode: DEFAULT_TERMINAL_APPEARANCE,
  hydrated: false,
  selectionRevision: 0,

  load: async () => {
    try {
      const result = await invoke("state:get", { key: "terminalAppearance" });
      const value = result.value as { mode?: unknown } | null;
      set((state) => ({
        mode: state.selectionRevision > 0
          ? state.mode
          : isTerminalAppearanceMode(value?.mode)
            ? value.mode
            : DEFAULT_TERMINAL_APPEARANCE,
        hydrated: true,
      }));
    } catch (error: unknown) {
      console.warn(
        "[terminal-appearance] load failed:",
        error instanceof Error ? error.message : String(error),
      );
      set((state) => ({
        mode: state.selectionRevision > 0 ? state.mode : DEFAULT_TERMINAL_APPEARANCE,
        hydrated: true,
      }));
    }
  },

  setMode: (mode) => {
    set((state) => ({ mode, selectionRevision: state.selectionRevision + 1 }));
    persist(mode);
  },
}));
