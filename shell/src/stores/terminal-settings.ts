import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_TERMINAL_THEME_ID, type TerminalThemeId } from "./terminal-defaults";

export { DEFAULT_TERMINAL_THEME_ID, type TerminalThemeId } from "./terminal-defaults";

export const TERMINAL_FONT_FAMILIES = ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"] as const;
export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILIES)[number];
export type TerminalCursorStyle = "block" | "bar" | "underline";

interface TerminalSettings {
  themeId: TerminalThemeId;
  fontSize: number;
  fontFamily: TerminalFontFamily;
  ligatures: boolean;
  cursorStyle: TerminalCursorStyle;
  smoothScroll: boolean;
  cursorBlink: boolean;
  setThemeId: (themeId: TerminalThemeId) => void;
  setFontSize: (fontSize: number) => void;
  setFontFamily: (fontFamily: TerminalFontFamily) => void;
  setLigatures: (ligatures: boolean) => void;
  setCursorStyle: (cursorStyle: TerminalCursorStyle) => void;
  setSmoothScroll: (smoothScroll: boolean) => void;
  setCursorBlink: (cursorBlink: boolean) => void;
}

export const useTerminalSettings = create<TerminalSettings>()(
  persist(
    (set) => ({
      themeId: DEFAULT_TERMINAL_THEME_ID,
      fontSize: 13,
      fontFamily: "MesloLGS NF",
      ligatures: true,
      cursorStyle: "block",
      smoothScroll: true,
      cursorBlink: true,
      setThemeId: (themeId) => set({ themeId }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setLigatures: (ligatures) => set({ ligatures }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setSmoothScroll: (smoothScroll) => set({ smoothScroll }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
    }),
    { name: "matrix-os-terminal-settings" },
  ),
);
