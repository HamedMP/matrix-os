import type { CSSProperties } from "react";
import { MATRIX_OS_APP_THEME_OPTIONS } from "@/lib/theme-presets";
import { DEFAULT_TERMINAL_APP_THEME_ID, type TerminalAppThemeId } from "@/stores/terminal-settings";

export type TerminalAppThemeOption = (typeof MATRIX_OS_APP_THEME_OPTIONS)[number];

export function getTerminalAppThemeOption(appThemeId: TerminalAppThemeId): TerminalAppThemeOption {
  const selected = MATRIX_OS_APP_THEME_OPTIONS.find((option) => option.id === appThemeId);
  if (selected) return selected;

  const fallback = MATRIX_OS_APP_THEME_OPTIONS.find((option) => option.id === DEFAULT_TERMINAL_APP_THEME_ID);
  if (fallback) return fallback;

  throw new Error("Default terminal app theme is not configured");
}

export interface TerminalAppChromeTheme {
  windowBackground: string;
  windowBorder: string;
  chromeBackground: string;
  chromeBorder: string;
  chromeForeground: string;
  chromeActive: string;
  chromeMuted: string;
  chromeSubtle: string;
  chromeControlBackground: string;
  chromeControlBorder: string;
  chromeControlForeground: string;
  chromeBadgeBackground: string;
  chromeBadgeBorder: string;
  chromeAccent: string;
  bodyBackground: string;
  drawerBackground: string;
  drawerBorder: string;
  drawerForeground: string;
  drawerMuted: string;
  drawerSubtle: string;
  drawerBrandBackground: string;
  drawerBrandForeground: string;
  drawerPrimaryButtonBackground: string;
  drawerPrimaryButtonForeground: string;
  drawerButtonBackground: string;
  drawerButtonBorder: string;
  drawerButtonForeground: string;
  drawerSearchBackground: string;
  drawerSearchBorder: string;
  drawerSearchIcon: string;
  drawerCardBackground: string;
  drawerCardSelectedBackground: string;
  drawerCardMutedBackground: string;
  drawerCardBorder: string;
  drawerCardMutedBorder: string;
  drawerSelectedBorder: string;
  drawerSelectedRing: string;
  drawerSelectedStripe: string;
  drawerCardShadow: string;
  drawerCardMutedShadow: string;
  drawerActionBackground: string;
  drawerActionBorder: string;
  drawerActionForeground: string;
  drawerWarningBackground: string;
  drawerWarningForeground: string;
  drawerToggleBackground: string;
  drawerToggleBorder: string;
  drawerToggleForeground: string;
  drawerToggleKnob: string;
  drawerToggleOffBackground: string;
  drawerToggleOffBorder: string;
  drawerToggleOffForeground: string;
  drawerToggleOffKnob: string;
  drawerDropLine: string;
}

export type TerminalAppChromeCssVars = CSSProperties & Record<`--${string}`, string>;

const TERMINAL_APP_CHROME_THEMES: Record<TerminalAppThemeId, TerminalAppChromeTheme> = {
  light: {
    windowBackground: "#171A13",
    windowBorder: "#32342E",
    chromeBackground: "#15180F",
    chromeBorder: "#24271F",
    chromeForeground: "#C9C7B7",
    chromeActive: "#F0EFE5",
    chromeMuted: "#858578",
    chromeSubtle: "#5F6258",
    chromeControlBackground: "#20241C",
    chromeControlBorder: "#2D3127",
    chromeControlForeground: "#C9C7B7",
    chromeBadgeBackground: "#20241C",
    chromeBadgeBorder: "#24271F",
    chromeAccent: "#CF7835",
    bodyBackground: "#1C2019",
    drawerBackground: "#E9E9D8",
    drawerBorder: "#D6D5C4",
    drawerForeground: "#31362D",
    drawerMuted: "#858578",
    drawerSubtle: "#A09F92",
    drawerBrandBackground: "#465243",
    drawerBrandForeground: "#F8F7EF",
    drawerPrimaryButtonBackground: "#465243",
    drawerPrimaryButtonForeground: "#F8F7EF",
    drawerButtonBackground: "#FFFDF7",
    drawerButtonBorder: "#D6D5C4",
    drawerButtonForeground: "#6F7167",
    drawerSearchBackground: "#FFFDF7",
    drawerSearchBorder: "#D6D5C4",
    drawerSearchIcon: "#A09F92",
    drawerCardBackground: "#FFFDF7",
    drawerCardSelectedBackground: "#FFFFFF",
    drawerCardMutedBackground: "#E2E2D0",
    drawerCardBorder: "#D6D5C4",
    drawerCardMutedBorder: "#D4D2C1",
    drawerSelectedBorder: "#9CB77A",
    drawerSelectedRing: "rgba(156,183,122,0.28)",
    drawerSelectedStripe: "#465243",
    drawerCardShadow: "rgba(39,40,34,0.13)",
    drawerCardMutedShadow: "transparent",
    drawerActionBackground: "#F0EFE5",
    drawerActionBorder: "#E4E2D2",
    drawerActionForeground: "#8A8B7C",
    drawerWarningBackground: "#F6EAC9",
    drawerWarningForeground: "#8F6712",
    drawerToggleBackground: "#DDEDD6",
    drawerToggleBorder: "#C9E1C2",
    drawerToggleForeground: "#24452A",
    drawerToggleKnob: "#4F8A55",
    drawerToggleOffBackground: "#D8D7C7",
    drawerToggleOffBorder: "#C8C7B7",
    drawerToggleOffForeground: "#77786E",
    drawerToggleOffKnob: "#F7F6EC",
    drawerDropLine: "#D8792C",
  },
  "matrix-dark": {
    windowBackground: "#171A13",
    windowBorder: "#32342E",
    chromeBackground: "#15180F",
    chromeBorder: "#24271F",
    chromeForeground: "#C9C7B7",
    chromeActive: "#F0EFE5",
    chromeMuted: "#858578",
    chromeSubtle: "#5F6258",
    chromeControlBackground: "#20241C",
    chromeControlBorder: "#2D3127",
    chromeControlForeground: "#C9C7B7",
    chromeBadgeBackground: "#20241C",
    chromeBadgeBorder: "#24271F",
    chromeAccent: "#CF7835",
    bodyBackground: "#1C2019",
    drawerBackground: "#15180F",
    drawerBorder: "#24271F",
    drawerForeground: "#F0EFE5",
    drawerMuted: "#858578",
    drawerSubtle: "#6F7167",
    drawerBrandBackground: "#465243",
    drawerBrandForeground: "#F8F7EF",
    drawerPrimaryButtonBackground: "#465243",
    drawerPrimaryButtonForeground: "#F8F7EF",
    drawerButtonBackground: "#20241C",
    drawerButtonBorder: "#2D3127",
    drawerButtonForeground: "#858578",
    drawerSearchBackground: "#20241C",
    drawerSearchBorder: "#2D3127",
    drawerSearchIcon: "#6F7167",
    drawerCardBackground: "#20241C",
    drawerCardSelectedBackground: "#30372B",
    drawerCardMutedBackground: "#171A13",
    drawerCardBorder: "#2D3127",
    drawerCardMutedBorder: "#24271F",
    drawerSelectedBorder: "#2D3127",
    drawerSelectedRing: "rgba(156,183,122,0.18)",
    drawerSelectedStripe: "#465243",
    drawerCardShadow: "rgba(0,0,0,0.22)",
    drawerCardMutedShadow: "transparent",
    drawerActionBackground: "#20241C",
    drawerActionBorder: "#2D3127",
    drawerActionForeground: "#858578",
    drawerWarningBackground: "#2A2008",
    drawerWarningForeground: "#E0A12E",
    drawerToggleBackground: "#1F3325",
    drawerToggleBorder: "#2E4A34",
    drawerToggleForeground: "#9CB77A",
    drawerToggleKnob: "#5FB85F",
    drawerToggleOffBackground: "#20241C",
    drawerToggleOffBorder: "#2D3127",
    drawerToggleOffForeground: "#6F7167",
    drawerToggleOffKnob: "#5A5D50",
    drawerDropLine: "#CF7835",
  },
  matrix: {
    windowBackground: "#07100A",
    windowBorder: "#16271B",
    chromeBackground: "#070D09",
    chromeBorder: "#16271B",
    chromeForeground: "#5BF08A",
    chromeActive: "#5BF08A",
    chromeMuted: "#4E8C61",
    chromeSubtle: "#2E5B39",
    chromeControlBackground: "#0E1810",
    chromeControlBorder: "#1C3324",
    chromeControlForeground: "#5BF08A",
    chromeBadgeBackground: "#0E1810",
    chromeBadgeBorder: "#1C3324",
    chromeAccent: "#CF7835",
    bodyBackground: "#1C2019",
    drawerBackground: "#08110B",
    drawerBorder: "#16271B",
    drawerForeground: "#9BFFB5",
    drawerMuted: "#4E8C61",
    drawerSubtle: "#2F7A44",
    drawerBrandBackground: "#0E3A1C",
    drawerBrandForeground: "#5BF08A",
    drawerPrimaryButtonBackground: "#0E3A1C",
    drawerPrimaryButtonForeground: "#5BF08A",
    drawerButtonBackground: "#0E1810",
    drawerButtonBorder: "#1C3324",
    drawerButtonForeground: "#4E8C61",
    drawerSearchBackground: "#0C150E",
    drawerSearchBorder: "#1C3324",
    drawerSearchIcon: "#2F7A44",
    drawerCardBackground: "#0F1A12",
    drawerCardSelectedBackground: "#1C3021",
    drawerCardMutedBackground: "#0B130D",
    drawerCardBorder: "#1C3324",
    drawerCardMutedBorder: "#16271B",
    drawerSelectedBorder: "#1C3324",
    drawerSelectedRing: "rgba(57,255,106,0.18)",
    drawerSelectedStripe: "#39FF6A",
    drawerCardShadow: "rgba(0,0,0,0.22)",
    drawerCardMutedShadow: "transparent",
    drawerActionBackground: "#0E1810",
    drawerActionBorder: "#1C3324",
    drawerActionForeground: "#4E8C61",
    drawerWarningBackground: "#2A2008",
    drawerWarningForeground: "#E0A12E",
    drawerToggleBackground: "#0F3A1E",
    drawerToggleBorder: "#1F5A30",
    drawerToggleForeground: "#9BFFB5",
    drawerToggleKnob: "#39FF6A",
    drawerToggleOffBackground: "#0E1810",
    drawerToggleOffBorder: "#1C3324",
    drawerToggleOffForeground: "#4E8C61",
    drawerToggleOffKnob: "#244E2D",
    drawerDropLine: "#39FF6A",
  },
};

export function getTerminalAppChromeTheme(appThemeId: TerminalAppThemeId): TerminalAppChromeTheme {
  return TERMINAL_APP_CHROME_THEMES[appThemeId] ?? TERMINAL_APP_CHROME_THEMES[DEFAULT_TERMINAL_APP_THEME_ID];
}

export function getTerminalAppChromeCssVars(theme: TerminalAppChromeTheme): TerminalAppChromeCssVars {
  return {
    "--terminal-app-window-bg": theme.windowBackground,
    "--terminal-app-window-border": theme.windowBorder,
    "--terminal-chrome-bg": theme.chromeBackground,
    "--terminal-chrome-border": theme.chromeBorder,
    "--terminal-chrome-fg": theme.chromeForeground,
    "--terminal-chrome-active": theme.chromeActive,
    "--terminal-chrome-muted": theme.chromeMuted,
    "--terminal-chrome-subtle": theme.chromeSubtle,
    "--terminal-chrome-control-bg": theme.chromeControlBackground,
    "--terminal-chrome-control-border": theme.chromeControlBorder,
    "--terminal-chrome-control-fg": theme.chromeControlForeground,
    "--terminal-chrome-badge-bg": theme.chromeBadgeBackground,
    "--terminal-chrome-badge-border": theme.chromeBadgeBorder,
    "--terminal-chrome-accent": theme.chromeAccent,
    "--terminal-app-body-bg": theme.bodyBackground,
    "--terminal-drawer-bg": theme.drawerBackground,
    "--terminal-drawer-border": theme.drawerBorder,
    "--terminal-drawer-fg": theme.drawerForeground,
    "--terminal-drawer-muted": theme.drawerMuted,
    "--terminal-drawer-subtle": theme.drawerSubtle,
    "--terminal-drawer-brand-bg": theme.drawerBrandBackground,
    "--terminal-drawer-brand-fg": theme.drawerBrandForeground,
    "--terminal-drawer-primary-button-bg": theme.drawerPrimaryButtonBackground,
    "--terminal-drawer-primary-button-fg": theme.drawerPrimaryButtonForeground,
    "--terminal-drawer-button-bg": theme.drawerButtonBackground,
    "--terminal-drawer-button-border": theme.drawerButtonBorder,
    "--terminal-drawer-button-fg": theme.drawerButtonForeground,
    "--terminal-drawer-search-bg": theme.drawerSearchBackground,
    "--terminal-drawer-search-border": theme.drawerSearchBorder,
    "--terminal-drawer-search-icon": theme.drawerSearchIcon,
    "--terminal-drawer-card-bg": theme.drawerCardBackground,
    "--terminal-drawer-card-selected-bg": theme.drawerCardSelectedBackground,
    "--terminal-drawer-card-muted-bg": theme.drawerCardMutedBackground,
    "--terminal-drawer-card-border": theme.drawerCardBorder,
    "--terminal-drawer-card-muted-border": theme.drawerCardMutedBorder,
    "--terminal-drawer-selected-border": theme.drawerSelectedBorder,
    "--terminal-drawer-selected-ring": theme.drawerSelectedRing,
    "--terminal-drawer-selected-stripe": theme.drawerSelectedStripe,
    "--terminal-drawer-card-shadow": theme.drawerCardShadow,
    "--terminal-drawer-card-muted-shadow": theme.drawerCardMutedShadow,
    "--terminal-drawer-action-bg": theme.drawerActionBackground,
    "--terminal-drawer-action-border": theme.drawerActionBorder,
    "--terminal-drawer-action-fg": theme.drawerActionForeground,
    "--terminal-drawer-warning-bg": theme.drawerWarningBackground,
    "--terminal-drawer-warning-fg": theme.drawerWarningForeground,
    "--terminal-drawer-toggle-bg": theme.drawerToggleBackground,
    "--terminal-drawer-toggle-border": theme.drawerToggleBorder,
    "--terminal-drawer-toggle-fg": theme.drawerToggleForeground,
    "--terminal-drawer-toggle-knob": theme.drawerToggleKnob,
    "--terminal-drawer-toggle-off-bg": theme.drawerToggleOffBackground,
    "--terminal-drawer-toggle-off-border": theme.drawerToggleOffBorder,
    "--terminal-drawer-toggle-off-fg": theme.drawerToggleOffForeground,
    "--terminal-drawer-toggle-off-knob": theme.drawerToggleOffKnob,
    "--terminal-drawer-drop-line": theme.drawerDropLine,
    "--terminal-drawer-scrollbar-thumb": "color-mix(in srgb, var(--terminal-drawer-border) 72%, transparent)",
    "--terminal-drawer-scrollbar-thumb-hover": "var(--terminal-drawer-border)",
    "--terminal-drawer-scrollbar-track": "var(--terminal-drawer-bg)",
    "--terminal-drawer-resize-handle-bg": "color-mix(in srgb, var(--terminal-drawer-border) 58%, transparent)",
    "--terminal-drawer-resize-handle-hover": "var(--terminal-drawer-border)",
    "--terminal-drawer-resize-handle-focus": "var(--terminal-drawer-selected-border)",
    "--terminal-mobile-primary-bg": theme.drawerPrimaryButtonBackground,
    "--terminal-mobile-primary-fg": theme.drawerPrimaryButtonForeground,
  };
}
