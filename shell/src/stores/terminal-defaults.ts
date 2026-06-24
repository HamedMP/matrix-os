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
export type TerminalAppThemeId = "light" | "matrix-dark" | "matrix";

export const DEFAULT_TERMINAL_THEME_ID: ShellThemeId = "dark";
export const DEFAULT_TERMINAL_APP_THEME_ID: TerminalAppThemeId = "matrix-dark";
