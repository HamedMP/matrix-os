import { customizeVariant, polishVariant, type CustomTheme } from "./customization.js";
import { lightCompanion } from "./light-variants.js";
import type {
  ChromeColors,
  EditorThemeColors,
  TerminalThemeColors,
  UnifiedThemeDefinition,
  UnifiedThemeVariant,
} from "./theme-types.js";
import { matrix } from "./matrix.js";
import { matrixNeon } from "./matrix-neon.js";
import { operator } from "./operator.js";
import { trueBlack } from "./true-black.js";
import { oneDark } from "./one-dark.js";
import { dracula } from "./dracula.js";
import { nord } from "./nord.js";
import { gruvbox } from "./gruvbox.js";
import { catppuccin } from "./catppuccin.js";
import { tokyoNight } from "./tokyo-night.js";
import { rosePine } from "./rose-pine.js";
import { solarized } from "./solarized.js";
import { kanagawa } from "./kanagawa.js";
import { vscode } from "./vscode.js";

export type {
  ChromeColors,
  EditorThemeColors,
  TerminalThemeColors,
  UnifiedThemeDefinition,
  UnifiedThemeVariant,
} from "./theme-types.js";

export const DEFAULT_THEME_ID = "matrix";
export { FONT_OPTIONS, MONO_FONT_OPTIONS, COLOR_FIELDS, normalizeCustomTheme, contrastRatio } from "./customization.js";
export type { CustomTheme, CustomColors, FontId, MonoFontId } from "./customization.js";

export const unifiedThemes: UnifiedThemeDefinition[] = [
  matrix,
  operator,
  matrixNeon,
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
].map((theme) => {
  const companions: Record<string, [string, string]> = {
    "matrix-neon": ["#f3fbf4", "#14391f"], "one-dark": ["#fafafa", "#383a42"],
    dracula: ["#f8f6fc", "#383347"], nord: ["#eceff4", "#2e3440"],
    gruvbox: ["#fbf1c7", "#3c3836"], kanagawa: ["#f2ecdf", "#43436c"],
  };
  const companion = companions[theme.id];
  return { ...theme, dark: theme.dark && polishVariant(theme.dark),
    light: theme.light ? polishVariant(theme.light) : lightCompanion(theme.dark!, ...companion!),
  };
});

const themeMap = new Map(unifiedThemes.map((theme) => [theme.id, theme]));

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && (value === "custom" || themeMap.has(value));
}

export function getUnifiedTheme(id: string): UnifiedThemeDefinition {
  return themeMap.get(id) ?? themeMap.get(DEFAULT_THEME_ID)!;
}

/**
 * Resolves the variant for a theme, falling back across the theme's own
 * variants (a dark-only theme renders dark even in light mode) and finally to
 * the default theme, which carries both variants.
 */
export function getThemeVariant(id: string, mode: "dark" | "light", custom?: CustomTheme | null): UnifiedThemeVariant {
  if (id === "custom" && custom) return customizeVariant(getThemeVariant(custom.baseThemeId === "custom" ? DEFAULT_THEME_ID : custom.baseThemeId, mode), custom[mode]);
  const theme = getUnifiedTheme(id);
  const fallback = getUnifiedTheme(DEFAULT_THEME_ID);
  return (mode === "dark" ? theme.dark : theme.light)
    ?? theme.dark
    ?? theme.light
    ?? (mode === "dark" ? fallback.dark : fallback.light)
    ?? fallback.dark!;
}

export function getThemeChrome(id: string, mode: "dark" | "light", custom?: CustomTheme | null): ChromeColors {
  return getThemeVariant(id, mode, custom).chrome;
}

export function getThemeTerminalColors(id: string, mode: "dark" | "light", custom?: CustomTheme | null): TerminalThemeColors {
  return getThemeVariant(id, mode, custom).terminal;
}

export function getThemeEditorColors(id: string, mode: "dark" | "light", custom?: CustomTheme | null): EditorThemeColors {
  return getThemeVariant(id, mode, custom).editor;
}
