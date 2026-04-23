import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TerminalThemeId =
  | "system"
  | "one-dark"
  | "one-light"
  | "catppuccin-mocha"
  | "dracula"
  | "solarized-dark"
  | "solarized-light"
  | "nord"
  | "github-dark"
  | "github-light";

interface TerminalSettings {
  themeId: TerminalThemeId;
  fontSize: number;
  cursorBlink: boolean;
  setThemeId: (themeId: TerminalThemeId) => void;
  setFontSize: (fontSize: number) => void;
  setCursorBlink: (cursorBlink: boolean) => void;
}

export const useTerminalSettings = create<TerminalSettings>()(
  persist(
    (set) => ({
      themeId: "system",
      fontSize: 13,
      cursorBlink: true,
      setThemeId: (themeId) => set({ themeId }),
      setFontSize: (fontSize) => set({ fontSize }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
    }),
    { name: "matrix-os-terminal-settings" },
  ),
);
