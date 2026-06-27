import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_TERMINAL_APP_THEME_ID,
  DEFAULT_TERMINAL_THEME_ID,
  type ShellThemeId,
  type TerminalAppThemeId,
  type TerminalThemeId,
} from "./terminal-defaults";

export {
  DEFAULT_TERMINAL_APP_THEME_ID,
  DEFAULT_TERMINAL_THEME_ID,
  type ShellThemeId,
  type TerminalAppThemeId,
  type TerminalThemeId,
} from "./terminal-defaults";

export const TERMINAL_FONT_FAMILIES = ["MesloLGS NF", "Berkeley Mono", "JetBrains Mono", "Fira Code"] as const;
export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILIES)[number];
export type TerminalCursorStyle = "block" | "bar" | "underline";

interface TerminalSettings {
  appThemeId: TerminalAppThemeId;
  themeId: TerminalThemeId;
  fontSize: number;
  fontFamily: TerminalFontFamily;
  ligatures: boolean;
  cursorStyle: TerminalCursorStyle;
  smoothScroll: boolean;
  cursorBlink: boolean;
  setAppThemeId: (appThemeId: TerminalAppThemeId) => void;
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
      appThemeId: DEFAULT_TERMINAL_APP_THEME_ID,
      themeId: DEFAULT_TERMINAL_THEME_ID,
      fontSize: 13,
      fontFamily: "MesloLGS NF",
      ligatures: true,
      cursorStyle: "block",
      smoothScroll: true,
      cursorBlink: true,
      setAppThemeId: (appThemeId) => set({ appThemeId }),
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
