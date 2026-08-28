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
  | "github-light"
  | "powerlevel10k-lean"
  | "powerlevel10k-lean-8-colors"
  | "powerlevel10k-classic"
  | "powerlevel10k-rainbow"
  | "powerlevel10k-pure";

export const SHELL_THEME_IDS = [
  "dark",
  "light",
  "matrix",
  "powerlevel10k-lean",
  "powerlevel10k-lean-8-colors",
  "powerlevel10k-classic",
  "powerlevel10k-rainbow",
  "powerlevel10k-pure",
] as const;

export type ShellThemeId = (typeof SHELL_THEME_IDS)[number];
export type TerminalAppThemeId = "light" | "matrix-dark" | "matrix";

export function isShellThemeId(value: unknown): value is ShellThemeId {
  return typeof value === "string" && SHELL_THEME_IDS.some((themeId) => themeId === value);
}

export const DEFAULT_TERMINAL_THEME_ID: ShellThemeId = "dark";
export const DEFAULT_TERMINAL_APP_THEME_ID: TerminalAppThemeId = "matrix-dark";
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
