import { getTerminalThemePreset } from "../../lib/terminal/terminal-themes";
import type { TerminalAppearanceMode } from "../../stores/terminal-appearance";
import { SURFACE_BASE_BACKGROUND_FALLBACK } from "../../design/surface";

export interface TerminalAppearanceTokens {
  surface: string;
  border: string;
  controlBorder: string;
  control: string;
  selected: string;
  text: string;
  muted: string;
}

const TERMINAL_APPEARANCE_TOKENS: Record<TerminalAppearanceMode, TerminalAppearanceTokens> = {
  dark: {
    surface: "#32352e",
    border: "#1f2a24",
    controlBorder: "#2d3a31",
    control: "#1f2a24",
    selected: "#434e3f",
    text: "#e5e7eb",
    muted: "#9ca3af",
  },
  light: {
    surface: "#fffffd",
    border: "#ebeae6",
    controlBorder: "#ebeae6",
    control: "#fafaf6",
    selected: "#fffffd",
    text: "#141413",
    muted: "#6f6f69",
  },
};

export function getTerminalAppearanceTokens(
  mode: TerminalAppearanceMode,
): TerminalAppearanceTokens {
  return TERMINAL_APPEARANCE_TOKENS[mode];
}

export function getDesktopTerminalXtermTheme(mode: TerminalAppearanceMode) {
  const tokens = getTerminalAppearanceTokens(mode);
  const preset = getTerminalThemePreset(mode === "dark" ? "one-dark" : "one-light");
  return {
    ...preset,
    background: SURFACE_BASE_BACKGROUND_FALLBACK,
    foreground: tokens.text,
  };
}
