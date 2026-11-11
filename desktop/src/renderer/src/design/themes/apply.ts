import { chromeToSemanticVars } from "@matrix-os/brand/themes/desktop-theme";
export { chromeToSemanticVars } from "@matrix-os/brand/themes/desktop-theme";
import type { CustomTheme } from "./index";
import { getThemeChrome, getUnifiedTheme } from "./index";

// tokens.css supplies the first paint. Every selected theme uses this same
// mapping so previews and the running interface remain consistent.

export type ThemeMode = "dark" | "light" | "system";

export function resolveThemeMode(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function effectiveThemeMode(themeId: string, requested: "dark" | "light"): "dark" | "light" {
  const theme = getUnifiedTheme(themeId);
  return theme[requested] ? requested : theme.dark ? "dark" : "light";
}

/**
 * Applies a unified theme to the document: sets data-theme for the stylesheet
 * variant and overrides the semantic variables with
 * the theme's chrome layer.
 */
export function applyUnifiedTheme(themeId: string, mode: ThemeMode, custom?: CustomTheme | null): void {
  const root = document.documentElement;
  const theme = getUnifiedTheme(themeId);
  const effective = effectiveThemeMode(themeId, resolveThemeMode(mode));
  root.setAttribute("data-theme", effective);
  const paletteId = themeId === "custom" && custom ? "custom" : theme.id;
  root.setAttribute("data-theme-id", paletteId);
  const vars = chromeToSemanticVars(getThemeChrome(themeId, effective, custom), paletteId);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
