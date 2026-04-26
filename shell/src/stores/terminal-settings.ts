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

export type TerminalFontFamily = "Berkeley Mono" | "JetBrains Mono" | "Fira Code";
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
      themeId: "system",
      fontSize: 13,
      fontFamily: "JetBrains Mono",
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
