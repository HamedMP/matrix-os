// Copied from shell/src/stores/terminal-defaults.ts + terminal-settings.ts (spec 094 R3 reuse).
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

export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = "one-dark";

export const TERMINAL_FONT_FAMILIES = [
  "MesloLGS NF",
  "Berkeley Mono",
  "JetBrains Mono",
  "Fira Code",
] as const;
export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILIES)[number];
export type TerminalCursorStyle = "block" | "bar" | "underline";
