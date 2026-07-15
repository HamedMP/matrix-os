import type { ChromeColors } from "./theme-types";
import { DEFAULT_THEME_ID, getThemeChrome, getUnifiedTheme } from "./index";

// tokens.css defines the semantic variables both statically (the Matrix brand
// theme, no flash before JS runs) and as the vocabulary every component
// consumes. Non-default themes override those variables inline on <html>;
// the Matrix theme removes the overrides so the stylesheet values win again.

export type ThemeMode = "dark" | "light" | "system";

export function resolveThemeMode(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

/** Semantic variables driven by a theme's chrome layer. */
export function chromeToSemanticVars(chrome: ChromeColors): Record<string, string> {
  return {
    "--bg-app": chrome.background,
    "--bg-surface": chrome.card,
    "--bg-raised": chrome.surface3,
    "--bg-overlay": chrome.popover,
    "--bg-sunken": chrome.surface0,
    "--bg-hover": chrome.accent,
    "--bg-active": chrome.secondary,
    "--bg-selected": chrome.secondary,

    "--forest": chrome.sidebar,
    "--forest-deep": chrome.surface0,
    "--forest-foreground": chrome.sidebarForeground,
    "--forest-muted": chrome.mutedForeground,

    "--border-subtle": chrome.sidebarBorder,
    "--border-default": chrome.border,
    "--border-strong": chrome.input,

    "--text-primary": chrome.foreground,
    "--text-secondary": chrome.mutedForeground,
    "--text-tertiary": chrome.mutedForeground,
    "--text-disabled": chrome.mutedForeground,
    "--text-on-accent": chrome.primaryForeground,

    "--accent": chrome.ring,
    "--accent-hover": chrome.sidebarPrimary,
    "--accent-muted": chrome.accent,
    "--highlight": chrome.chart4,
    "--highlight-muted": chrome.accent,
    "--success": chrome.chart2,
    "--success-muted": chrome.accent,
    "--warning": chrome.chart3,
    "--warning-muted": chrome.accent,
    "--danger": chrome.destructive,
    "--danger-muted": chrome.accent,
    "--info": chrome.chart1,
    "--info-muted": chrome.accent,

    "--status-todo": chrome.mutedForeground,
    "--status-running": chrome.chart1,
    "--status-waiting": chrome.chart3,
    "--status-blocked": chrome.destructive,
    "--status-complete": chrome.chart2,
    "--status-attention": chrome.chart3,
    "--status-failed": chrome.destructive,

    // color-mix keeps the ring translucent for any CSS color form (hex,
    // rgba, oklch); appending a hex alpha only works for 6-digit hex.
    "--focus-ring": `0 0 0 3px color-mix(in srgb, ${chrome.ring} 33%, transparent)`,
  };
}

const MANAGED_VARS = Object.keys(chromeToSemanticVars(getThemeChrome(DEFAULT_THEME_ID, "dark")));

/**
 * Applies a unified theme to the document: sets data-theme for the stylesheet
 * variant and, for non-Matrix themes, overrides the semantic variables with
 * the theme's chrome layer.
 */
export function applyUnifiedTheme(themeId: string, mode: ThemeMode): void {
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
  root.setAttribute("data-theme-id", theme.id);
  if (theme.id === "matrix") {
    for (const name of MANAGED_VARS) root.style.removeProperty(name);
    return;
  }
  const vars = chromeToSemanticVars(getThemeChrome(theme.id, effective));
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
