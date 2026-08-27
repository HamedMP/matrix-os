import type { CSSProperties } from "react";

export type DesktopTerminalAppThemeId = "light" | "matrix-dark" | "matrix";

export const DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID: DesktopTerminalAppThemeId = "matrix-dark";

export const DESKTOP_TERMINAL_APP_THEME_OPTIONS = [
  { id: "light", name: "Light", description: "Warm paper" },
  { id: "matrix-dark", name: "Matrix OS Dark", description: "Warm dark" },
  { id: "matrix", name: "Matrix", description: "Phosphor green" },
] as const satisfies ReadonlyArray<{
  id: DesktopTerminalAppThemeId;
  name: string;
  description: string;
}>;

interface DesktopTerminalAppTheme {
  windowBackground: string;
  windowBorder: string;
  bodyBackground: string;
  chromeBorder: string;
  chromeForeground: string;
  chromeMuted: string;
  chromeBadgeBackground: string;
  chromeBadgeBorder: string;
  chromeAccent: string;
  drawerBackground: string;
  drawerBorder: string;
  drawerForeground: string;
  drawerMuted: string;
  drawerPrimaryButtonBackground: string;
  drawerPrimaryButtonForeground: string;
  drawerCardBackground: string;
  drawerCardSelectedBackground: string;
  drawerSelectedStripe: string;
  drawerDestructiveForeground: string;
}

const THEMES: Record<DesktopTerminalAppThemeId, DesktopTerminalAppTheme> = {
  light: {
    windowBackground: "#171A13",
    windowBorder: "#32342E",
    bodyBackground: "#1C2019",
    chromeBorder: "#24271F",
    chromeForeground: "#C9C7B7",
    chromeMuted: "#858578",
    chromeBadgeBackground: "#20241C",
    chromeBadgeBorder: "#24271F",
    chromeAccent: "#CF7835",
    drawerBackground: "#E9E9D8",
    drawerBorder: "#D6D5C4",
    drawerForeground: "#31362D",
    drawerMuted: "#858578",
    drawerPrimaryButtonBackground: "#465243",
    drawerPrimaryButtonForeground: "#F8F7EF",
    drawerCardBackground: "#FFFDF7",
    drawerCardSelectedBackground: "#FFFFFF",
    drawerSelectedStripe: "#465243",
    drawerDestructiveForeground: "#B8403A",
  },
  "matrix-dark": {
    windowBackground: "#171A13",
    windowBorder: "#32342E",
    bodyBackground: "#1C2019",
    chromeBorder: "#24271F",
    chromeForeground: "#C9C7B7",
    chromeMuted: "#858578",
    chromeBadgeBackground: "#20241C",
    chromeBadgeBorder: "#24271F",
    chromeAccent: "#CF7835",
    drawerBackground: "#15180F",
    drawerBorder: "#24271F",
    drawerForeground: "#F0EFE5",
    drawerMuted: "#858578",
    drawerPrimaryButtonBackground: "#465243",
    drawerPrimaryButtonForeground: "#F8F7EF",
    drawerCardBackground: "#20241C",
    drawerCardSelectedBackground: "#30372B",
    drawerSelectedStripe: "#465243",
    drawerDestructiveForeground: "#E8796B",
  },
  matrix: {
    windowBackground: "#07100A",
    windowBorder: "#16271B",
    bodyBackground: "#1C2019",
    chromeBorder: "#16271B",
    chromeForeground: "#5BF08A",
    chromeMuted: "#4E8C61",
    chromeBadgeBackground: "#0E1810",
    chromeBadgeBorder: "#1C3324",
    chromeAccent: "#CF7835",
    drawerBackground: "#08110B",
    drawerBorder: "#16271B",
    drawerForeground: "#9BFFB5",
    drawerMuted: "#4E8C61",
    drawerPrimaryButtonBackground: "#0E3A1C",
    drawerPrimaryButtonForeground: "#5BF08A",
    drawerCardBackground: "#0F1A12",
    drawerCardSelectedBackground: "#1C3021",
    drawerSelectedStripe: "#39FF6A",
    drawerDestructiveForeground: "#FF6B6B",
  },
};

export type DesktopTerminalAppCssVars = CSSProperties & Record<`--${string}`, string>;

export function isDesktopTerminalAppThemeId(value: unknown): value is DesktopTerminalAppThemeId {
  return value === "light" || value === "matrix-dark" || value === "matrix";
}

export function getDesktopTerminalAppCssVars(
  appThemeId: DesktopTerminalAppThemeId,
): DesktopTerminalAppCssVars {
  const theme = THEMES[appThemeId] ?? THEMES[DEFAULT_DESKTOP_TERMINAL_APP_THEME_ID];
  return {
    "--terminal-app-window-bg": theme.windowBackground,
    "--terminal-app-window-border": theme.windowBorder,
    "--terminal-app-body-bg": theme.bodyBackground,
    "--terminal-chrome-border": theme.chromeBorder,
    "--terminal-chrome-fg": theme.chromeForeground,
    "--terminal-chrome-muted": theme.chromeMuted,
    "--terminal-chrome-badge-bg": theme.chromeBadgeBackground,
    "--terminal-chrome-badge-border": theme.chromeBadgeBorder,
    "--terminal-chrome-accent": theme.chromeAccent,
    "--terminal-drawer-bg": theme.drawerBackground,
    "--terminal-drawer-border": theme.drawerBorder,
    "--terminal-drawer-fg": theme.drawerForeground,
    "--terminal-drawer-muted": theme.drawerMuted,
    "--terminal-drawer-primary-button-bg": theme.drawerPrimaryButtonBackground,
    "--terminal-drawer-primary-button-fg": theme.drawerPrimaryButtonForeground,
    "--terminal-drawer-card-bg": theme.drawerCardBackground,
    "--terminal-drawer-card-selected-bg": theme.drawerCardSelectedBackground,
    "--terminal-drawer-selected-stripe": theme.drawerSelectedStripe,
    "--terminal-drawer-destructive-fg": theme.drawerDestructiveForeground,
  };
}
