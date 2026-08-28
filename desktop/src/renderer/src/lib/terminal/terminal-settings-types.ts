// Copied from shell/src/stores/terminal-defaults.ts + terminal-settings.ts (spec 094 R3 reuse).
export type TerminalThemeId =
  | "light"
  | "matrix-dark"
  | "matrix"
  | "powerlevel10k-lean"
  | "powerlevel10k-lean-8-colors"
  | "powerlevel10k-classic"
  | "powerlevel10k-rainbow"
  | "powerlevel10k-pure";

export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = "matrix-dark";

export const TERMINAL_FONT_FAMILIES = [
  "MesloLGS NF",
  "Berkeley Mono",
  "JetBrains Mono",
  "Fira Code",
] as const;
export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILIES)[number];
export type TerminalCursorStyle = "block" | "bar" | "underline";
