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

/**
 * Applies a unified theme to the document: sets data-theme for the stylesheet
 * variant and overrides the semantic variables with
 * the theme's chrome layer.
 */
export function applyUnifiedTheme(themeId: string, mode: ThemeMode, custom?: CustomTheme | null): void {
  const root = document.documentElement;
  const theme = getUnifiedTheme(themeId);
  const requested = resolveThemeMode(mode);
  // A single-variant theme renders its own variant regardless of mode, and
  // data-theme must match so stylesheet fallbacks stay coherent.
  const effective = (requested === "dark" ? theme.dark : theme.light)
    ? requested
    : theme.dark
      ? "dark"
      : "light";
  root.setAttribute("data-theme", effective);
  root.setAttribute("data-theme-id", themeId === "custom" && custom ? "custom" : theme.id);
  const vars = chromeToSemanticVars(getThemeChrome(themeId, effective, custom));
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
