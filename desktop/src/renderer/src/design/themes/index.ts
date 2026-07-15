import type {
  ChromeColors,
  EditorThemeColors,
  TerminalThemeColors,
  UnifiedThemeDefinition,
  UnifiedThemeVariant,
} from "./theme-types";
import { matrix } from "./matrix";
import { operator } from "./operator";
import { trueBlack } from "./true-black";
import { oneDark } from "./one-dark";
import { dracula } from "./dracula";
import { nord } from "./nord";
import { gruvbox } from "./gruvbox";
import { catppuccin } from "./catppuccin";
import { tokyoNight } from "./tokyo-night";
import { rosePine } from "./rose-pine";
import { solarized } from "./solarized";
import { kanagawa } from "./kanagawa";
import { vscode } from "./vscode";

export type {
  ChromeColors,
  EditorThemeColors,
  TerminalThemeColors,
  UnifiedThemeDefinition,
  UnifiedThemeVariant,
} from "./theme-types";

export const DEFAULT_THEME_ID = "operator";

export const unifiedThemes: UnifiedThemeDefinition[] = [
  operator,
  matrix,
  trueBlack,
  oneDark,
  dracula,
  nord,
  gruvbox,
  catppuccin,
  tokyoNight,
  rosePine,
  solarized,
  kanagawa,
  vscode,
];

const themeMap = new Map(unifiedThemes.map((theme) => [theme.id, theme]));

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && themeMap.has(value);
}

export function getUnifiedTheme(id: string): UnifiedThemeDefinition {
  return themeMap.get(id) ?? themeMap.get(DEFAULT_THEME_ID)!;
}

/**
 * Resolves the variant for a theme, falling back across the theme's own
 * variants (a dark-only theme renders dark even in light mode) and finally to
 * the default theme, which carries both variants.
 */
export function getThemeVariant(id: string, mode: "dark" | "light"): UnifiedThemeVariant {
  const theme = getUnifiedTheme(id);
  const fallback = getUnifiedTheme(DEFAULT_THEME_ID);
  return (mode === "dark" ? theme.dark : theme.light)
    ?? theme.dark
    ?? theme.light
    ?? (mode === "dark" ? fallback.dark : fallback.light)
    ?? fallback.dark!;
}

export function getThemeChrome(id: string, mode: "dark" | "light"): ChromeColors {
  return getThemeVariant(id, mode).chrome;
}

export function getThemeTerminalColors(id: string, mode: "dark" | "light"): TerminalThemeColors {
  return getThemeVariant(id, mode).terminal;
}

export function getThemeEditorColors(id: string, mode: "dark" | "light"): EditorThemeColors {
  return getThemeVariant(id, mode).editor;
}
