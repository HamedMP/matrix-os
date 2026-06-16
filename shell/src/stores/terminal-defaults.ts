export type TerminalThemeId =
  | "dark"
  | "light"
  | "matrix"
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

export type ShellThemeId = "dark" | "light" | "matrix";

export const DEFAULT_TERMINAL_THEME_ID: ShellThemeId = "dark";
