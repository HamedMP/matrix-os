"use client";

import { createContext, use, useEffect, useEffectEvent, useRef, useCallback, useState, type CSSProperties, type KeyboardEvent, type MouseEventHandler, type PointerEvent as ReactPointerEvent, type PointerEventHandler } from "react";
import Image from "next/image";
import {
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ClipboardPasteIcon,
  FilesIcon,
  FolderIcon,
  GripVerticalIcon,
  KeyboardIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows2Icon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { type PaneNode, countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { drainTerminalLaunchQueue, TERMINAL_LAUNCH_EVENT } from "@/lib/terminal-launch";
import { MATRIX_OS_APP_THEME_OPTIONS } from "@/lib/theme-presets";
import { DEFAULT_TERMINAL_APP_THEME_ID, useTerminalSettings, type ShellThemeId, type TerminalAppThemeId, type TerminalThemeId } from "@/stores/terminal-settings";
import { getTerminalThemePreset } from "./terminal-themes";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { isCanonicalShellSessionId, isLegacyPtySessionId } from "./terminal-session-id";
import { sessionAccent, twoWordSessionName } from "./terminal-session-names";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import {
  applyShellRefreshFailure,
  applyShellRefreshSilentFailure,
  applyShellRefreshSuccess,
  applyShellUiStatePatch,
  rollbackShellUiStatePatch,
  shellSessionsEqual,
  snapshotShellUiStatePatch,
  type ShellRefreshState,
  type ShellSessionSummary,
  type ShellUiStatePatch,
} from "./terminal-session-state";

export { TERMINAL_INPUT_EVENT };
export type { TerminalInputEventDetail };

const TOOLBAR_BTN_BASE_STYLE: CSSProperties = {
  height: 28,
  minWidth: 28,
  fontSize: 12,
  borderRadius: 6,
};

const PAPER_THEME_BUTTON_STYLE: CSSProperties = {
  alignItems: "center",
  background: "var(--terminal-drawer-button-bg)",
  borderColor: "var(--terminal-drawer-button-border)",
  borderRadius: 9,
  borderStyle: "solid",
  borderWidth: 1,
  color: "var(--terminal-drawer-button-fg)",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 600,
  gap: 8,
  height: 34,
  justifyContent: "center",
  padding: "0 12px",
};

const TERMINAL_THEME_MOBILE_DIALOG_STYLE: CSSProperties = {
  alignItems: "flex-end",
  background: "rgba(2, 5, 2, 0.42)",
  border: 0,
  display: "flex",
  height: "100dvh",
  inset: 0,
  justifyContent: "center",
  margin: 0,
  maxHeight: "none",
  maxWidth: "none",
  overflow: "hidden",
  padding: 0,
  position: "fixed",
  width: "100vw",
  zIndex: 94,
};

const TERMINAL_THEME_MOBILE_SHEET_STYLE: CSSProperties = {
  background: "#FFFDF7",
  borderRadius: "26px 26px 0 0",
  boxShadow: "0 -18px 50px rgba(0, 0, 0, 0.44)",
  color: "#2A2E22",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "10px 20px 17px",
  position: "relative",
  width: "min(390px, 100%)",
  zIndex: 1,
};

const TERMINAL_THEME_DESKTOP_MENU_STYLE: CSSProperties = {
  background: "#20241C",
  border: "1px solid #2D3127",
  borderRadius: 14,
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.42)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 8,
  padding: 6,
  position: "absolute",
  right: 0,
  top: "100%",
  width: 280,
  zIndex: 90,
};

type ThemeMenuPlacement = "below-end" | "above-start";

function getTerminalThemeDesktopMenuPositionStyle(placement: ThemeMenuPlacement): CSSProperties {
  if (placement === "above-start") {
    return {
      bottom: "100%",
      left: 0,
      marginBottom: 8,
      marginTop: 0,
      right: "auto",
      top: "auto",
    };
  }

  return {};
}

const TERMINAL_THEME_MENU_DISMISS_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "default",
  inset: 0,
  padding: 0,
  position: "absolute",
};

const TERMINAL_SHELL_THEME_MOTION_CSS = `
@keyframes terminalShellThemePanelIn {
  0% {
    opacity: 0;
    transform: translate3d(0, -8px, 0) scale(0.975);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalShellThemeMobilePanelIn {
  0% {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalShellThemeRowIn {
  0% {
    opacity: 0;
    transform: translate3d(0, 6px, 0);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
}

@keyframes terminalShellThemeBadgeIn {
  0% {
    opacity: 0;
    transform: translate3d(8px, 0, 0) scale(0.9);
  }
  68% {
    opacity: 1;
    transform: translate3d(-1px, 0, 0) scale(1.04);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalShellThemeCheckIn {
  0% {
    opacity: 0;
    transform: scale(0.72);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-terminal-shell-theme-motion] {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
`;

const TERMINAL_SHELL_THEME_DESKTOP_PANEL_STYLE: CSSProperties = {
  ...TERMINAL_THEME_DESKTOP_MENU_STYLE,
  background: "var(--terminal-chrome-bg)",
  border: "1px solid var(--terminal-chrome-control-border)",
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.44)",
  gap: 10,
  padding: 10,
  width: 386,
};

const TERMINAL_SHELL_THEME_DESKTOP_HEADER_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 10,
  padding: "2px 2px 0",
};

const TERMINAL_SHELL_THEME_MOBILE_HEADER_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 12,
};

const TERMINAL_THEME_MENU_ITEM_TEXT_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: 1,
  minWidth: 0,
};

function getTerminalThemeMenuItemStyle(mobile: boolean, selected: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: selected ? (mobile ? "#F4F3E9" : "#2A2E22") : "transparent",
    border: mobile ? `1px solid ${selected ? "#E4E2D2" : "transparent"}` : 0,
    borderRadius: mobile ? 14 : 10,
    color: mobile ? "#2A2E22" : "#F0EFE5",
    cursor: "pointer",
    display: "flex",
    gap: mobile ? 14 : 12,
    minHeight: mobile ? 64 : 51,
    padding: mobile ? "12px 14px" : "8px 10px",
    textAlign: "left",
    width: "100%",
  };
}

function getTerminalThemePreviewStyle(option: TerminalAppThemeOption, mobile: boolean): CSSProperties {
  return {
    background: option.preview.background,
    border: `1px solid ${option.preview.border}`,
    borderRadius: mobile ? 9 : 8,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: mobile ? 5 : 4,
    height: mobile ? 38 : 32,
    justifyContent: "center",
    padding: mobile ? 9 : 7,
    width: mobile ? 48 : 40,
  };
}

function getChangeShellThemeMenuItemStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: mobile ? "#F4F3E9" : "transparent",
    border: mobile ? "1px solid #E4E2D2" : 0,
    borderRadius: mobile ? 14 : 10,
    cursor: "pointer",
    display: "flex",
    gap: mobile ? 14 : 12,
    minHeight: mobile ? 64 : 48,
    padding: mobile ? "12px 14px" : "8px 10px",
    textAlign: "left",
    width: "100%",
  };
}

function getChangeShellThemeIconStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: mobile ? "#15180F" : "#171A13",
    border: mobile ? 0 : "1px solid #2D3127",
    borderRadius: mobile ? 10 : 8,
    color: mobile ? "#9CB77A" : "#6F7167",
    display: "flex",
    flexShrink: 0,
    height: mobile ? 38 : 32,
    justifyContent: "center",
    width: mobile ? 38 : 40,
  };
}

const SHELL_ROW_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 10,
  cursor: "pointer",
  inset: 0,
  padding: 0,
  position: "absolute",
  zIndex: 0,
};

const SHELL_ROW_DRAG_HANDLE_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--terminal-drawer-subtle)",
  flexShrink: 0,
  height: 18,
  padding: 0,
  pointerEvents: "auto",
  transition: "opacity 120ms ease",
  width: 12,
};

const SHELL_THEME_OPTIONS: Array<{
  id: ShellThemeId;
  label: string;
  badge: "RECOMMENDED" | "NOT FULLY TUNED";
  badgeTone: "recommended" | "warning";
  description: string;
  preview: {
    background: string;
    border: string;
    line: string;
    dotA: string;
    dotB: string;
  };
}> = [
  {
    id: "dark",
    label: "Dark",
    badge: "RECOMMENDED",
    badgeTone: "recommended",
    description: "Zellij default · best contrast",
    preview: {
      background: "#0C0C0C",
      border: "#15180F",
      line: "#0AD18B",
      dotA: "#2BD9D9",
      dotB: "#F1FA5C",
    },
  },
  {
    id: "light",
    label: "Light",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "gruvbox-light",
    preview: {
      background: "#FBF1C7",
      border: "#E4D9B0",
      line: "#3C3836",
      dotA: "#79740E",
      dotB: "#CC241D",
    },
  },
  {
    id: "matrix",
    label: "Matrix",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "custom · green on black",
    preview: {
      background: "#020A02",
      border: "#0E5A26",
      line: "#39FF6A",
      dotA: "#5BF08A",
      dotB: "#00CC44",
    },
  },
];

type TerminalAppThemeOption = (typeof MATRIX_OS_APP_THEME_OPTIONS)[number];

function getTerminalAppThemeOption(appThemeId: TerminalAppThemeId): TerminalAppThemeOption {
  const selected = MATRIX_OS_APP_THEME_OPTIONS.find((option) => option.id === appThemeId);
  if (selected) return selected;

  const fallback = MATRIX_OS_APP_THEME_OPTIONS.find((option) => option.id === DEFAULT_TERMINAL_APP_THEME_ID);
  if (fallback) return fallback;

  throw new Error("Default terminal app theme is not configured");
}

interface TerminalAppChromeTheme {
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

type TerminalAppChromeCssVars = CSSProperties & Record<`--${string}`, string>;

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

function getTerminalAppChromeTheme(appThemeId: TerminalAppThemeId): TerminalAppChromeTheme {
  return TERMINAL_APP_CHROME_THEMES[appThemeId] ?? TERMINAL_APP_CHROME_THEMES[DEFAULT_TERMINAL_APP_THEME_ID];
}

function getTerminalAppChromeCssVars(theme: TerminalAppChromeTheme): TerminalAppChromeCssVars {
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
  };
}

const TAB_ITEM_BASE_STYLE: CSSProperties = {
  borderRadius: 6,
  fontSize: 12,
  height: 34,
};

const TAB_CLOSE_BUTTON_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  flexShrink: 0,
  borderRadius: 3,
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  opacity: 0.5,
  marginLeft: "auto",
};

const ACTIVE_TAB_PILL_STYLE: CSSProperties = {
  alignItems: "center",
  alignSelf: "center",
  background: "color-mix(in srgb, var(--primary) 16%, transparent)",
  border: "1px solid color-mix(in srgb, var(--primary) 44%, transparent)",
  borderRadius: 999,
  color: "var(--primary)",
  display: "inline-flex",
  flex: "0 0 auto",
  fontSize: 10,
  fontWeight: 800,
  height: 16,
  lineHeight: "14px",
  overflow: "hidden",
  padding: "0 5px",
};

const SHELL_NEW_BUTTON_BASE_STYLE: CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "var(--primary)",
  color: "var(--primary-foreground)",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const SIDEBAR_RAIL_BUTTON_BASE_STYLE: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
};

const SHELLS_REFRESH_INTERVAL_MS = 5_000;
const SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 392;
const MIN_TERMINAL_SIDEBAR_WIDTH = 280;
const MAX_TERMINAL_SIDEBAR_WIDTH = 560;
const TERMINAL_SIDEBAR_TRANSITION = "opacity 140ms ease, transform 180ms ease";
const SESSION_ACTIONS_STYLE: CSSProperties = {
  gap: 6,
  position: "absolute",
  // Anchored to the grid row, whose right edge is inset by the card's 12px
  // padding; a small negative right pulls the actions flush to the card edge.
  right: -8,
  top: "50%",
  transform: "translateY(-50%)",
  transition: "opacity 120ms ease",
  justifyContent: "flex-end",
};
const SESSION_RENAME_BUTTON_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-action-fg)",
  flexShrink: 0,
  height: 22,
  pointerEvents: "auto",
  transition: "opacity 120ms ease",
  width: 22,
};
const SESSION_MORE_BUTTON_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-action-fg)",
  cursor: "pointer",
  flexShrink: 0,
  height: 24,
  pointerEvents: "auto",
  position: "relative",
  transition: "opacity 120ms ease",
  width: 24,
};
const SESSION_CONTEXT_MENU_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-card-bg)",
  border: "1px solid var(--terminal-drawer-card-border)",
  borderRadius: 9,
  boxShadow: "0 14px 34px var(--terminal-drawer-card-shadow)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 152,
  padding: 5,
  position: "absolute",
  right: 0,
  top: "calc(100% + 6px)",
  zIndex: 20,
};
const SESSION_CONTEXT_MENU_ITEM_STYLE: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "var(--terminal-drawer-fg)",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 650,
  gap: 7,
  height: 28,
  padding: "0 8px",
  textAlign: "left",
  whiteSpace: "nowrap",
  width: "100%",
};
const SESSION_COPY_FEEDBACK_STYLE: CSSProperties = {
  alignItems: "center",
  background: "var(--terminal-drawer-action-bg)",
  border: "1px solid var(--terminal-drawer-action-border)",
  borderRadius: 999,
  color: "var(--terminal-drawer-action-fg)",
  display: "inline-flex",
  flexShrink: 0,
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 750,
  gap: 5,
  height: 24,
  lineHeight: "14px",
  padding: "0 8px",
  pointerEvents: "none",
  whiteSpace: "nowrap",
};
const SESSION_NAME_BUTTON_BASE_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 14,
  fontWeight: 700,
  lineHeight: "18px",
  minWidth: 0,
  padding: 0,
  pointerEvents: "auto",
  textAlign: "left",
};
const SESSION_RENAME_INPUT_STYLE: CSSProperties = {
  background: "var(--terminal-drawer-card-bg)",
  border: "1px solid var(--terminal-drawer-card-border)",
  borderRadius: 6,
  color: "var(--terminal-drawer-fg)",
  flex: "1 1 auto",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 14,
  fontWeight: 700,
  height: 24,
  lineHeight: "18px",
  minWidth: 0,
  outline: "none",
  padding: "0 6px",
  pointerEvents: "auto",
};
const SHELL_STATUS_DOT_CSS = `
@keyframes terminal-session-status-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(95, 184, 95, 0.24); }
  50% { box-shadow: 0 0 0 6px rgba(95, 184, 95, 0.10); }
}
@keyframes terminal-refresh-spin {
  to { transform: rotate(360deg); }
}
.terminal-session-status-dot--running {
  animation: terminal-session-status-pulse 1.35s ease-in-out infinite;
}
.terminal-refresh-icon--loading {
  animation: terminal-refresh-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .terminal-session-status-dot--running,
  .terminal-refresh-icon--loading {
    animation: none;
  }
}
`;

const PROJECT_BRANCH_BADGE_STYLE: CSSProperties = {
  padding: "1px 5px",
  borderRadius: 3,
  background: "var(--background)",
  border: "1px solid var(--border)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  maxWidth: 100,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function dispatchPaneInput(paneId: string | null, data: string): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, data, action: "input" },
    }),
  );
}

function dispatchPaneAction(paneId: string | null, action: NonNullable<TerminalInputEventDetail["action"]>): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, action },
    }),
  );
}

async function copyTextToClipboard(text: string): Promise<void> {
  let legacyCopyError: unknown = null;
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousSelection = document.getSelection()?.rangeCount ? document.getSelection()?.getRangeAt(0).cloneRange() : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      if (document.execCommand("copy")) {
        return;
      }
      legacyCopyError = new Error("execCommand copy returned false");
    } catch (err: unknown) {
      legacyCopyError = err;
    } finally {
      textarea.remove();
      const selection = document.getSelection();
      if (selection) {
        selection.removeAllRanges();
        if (previousSelection) {
          selection.addRange(previousSelection);
        }
      }
      previousActiveElement?.focus({ preventScroll: true });
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error(legacyCopyError instanceof Error ? legacyCopyError.message : "Clipboard copy unavailable");
}

const DEFAULT_CWD = "projects";
const DEFAULT_SHELL_SESSION_NAME = "main";

interface Tab {
  id: string;
  label: string;
  paneTree: PaneNode;
}

interface TerminalLayout {
  tabs?: Tab[];
  activeTabId?: string;
  sidebarOpen?: boolean;
}

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

function terminalSessionName(prefix = "matrix") {
  const normalized = prefix.toLowerCase();
  // A meaningful prefix (e.g. a project name) keeps the prefixed form; the
  // default produces a friendly two-word handle instead of matrix-<random>.
  if (normalized && normalized !== "matrix") {
    const safePrefix = normalized
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 22) || "matrix";
    return `${safePrefix}-${genId()}`.slice(0, 31);
  }
  return twoWordSessionName();
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readShellErrorCode(res: Response): Promise<string | null> {
  try {
    const data = await res.clone().json() as { error?: { code?: unknown } };
    return typeof data.error?.code === "string" ? data.error.code : null;
  } catch (err: unknown) {
    console.warn("Failed to parse shell error response:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function splitPaneInTree(node: PaneNode, paneId: string, dir: "horizontal" | "vertical"): PaneNode {
  if (node.type === "pane") {
    if (node.id === paneId) {
      return { type: "split", direction: dir, children: [node, { type: "pane", id: genId(), cwd: node.cwd }], ratio: 0.5 };
    }
    return node;
  }
  return { ...node, children: [splitPaneInTree(node.children[0], paneId, dir), splitPaneInTree(node.children[1], paneId, dir)] };
}

function closePaneInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const l = node.children[0], r = node.children[1];
  if (l.type === "pane" && l.id === paneId) return r;
  if (r.type === "pane" && r.id === paneId) return l;
  const nl = closePaneInTree(l, paneId);
  const nr = closePaneInTree(r, paneId);
  if (!nl) return nr;
  if (!nr) return nl;
  return { ...node, children: [nl, nr] };
}

function getFirstPaneId(node: PaneNode): string {
  if (node.type === "pane") return node.id;
  return getFirstPaneId(node.children[0]);
}

function setPaneSessionId(node: PaneNode, paneId: string, sessionId: string): PaneNode {
  if (node.type === "pane") {
    if (node.id !== paneId || node.sessionId === sessionId) {
      return node;
    }
    return { ...node, sessionId };
  }

  const left = setPaneSessionId(node.children[0], paneId, sessionId);
  const right = setPaneSessionId(node.children[1], paneId, sessionId);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

function renameSessionInTree(node: PaneNode, fromSessionId: string, toSessionId: string): PaneNode {
  if (node.type === "pane") {
    return node.sessionId === fromSessionId ? { ...node, sessionId: toSessionId } : node;
  }
  const left = renameSessionInTree(node.children[0], fromSessionId, toSessionId);
  const right = renameSessionInTree(node.children[1], fromSessionId, toSessionId);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

function hasPaneId(node: PaneNode, paneId: string): boolean {
  if (node.type === "pane") {
    return node.id === paneId;
  }
  return hasPaneId(node.children[0], paneId) || hasPaneId(node.children[1], paneId);
}

function getPaneSessionId(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.sessionId ?? null : null;
  }
  return getPaneSessionId(node.children[0], paneId) ?? getPaneSessionId(node.children[1], paneId);
}

function getPaneCwd(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.cwd : null;
  }
  return getPaneCwd(node.children[0], paneId) ?? getPaneCwd(node.children[1], paneId);
}

function formatCwd(value: string): string {
  if (value === DEFAULT_CWD) return "~/projects";
  if (value.startsWith(DEFAULT_CWD + "/")) return `~/${value}`;
  return value;
}

function getSessionIds(node: PaneNode): string[] {
  if (node.type === "pane") {
    return node.sessionId ? [node.sessionId] : [];
  }
  return [...getSessionIds(node.children[0]), ...getSessionIds(node.children[1])];
}

function getPaneIdsForSession(node: PaneNode, sessionId: string): string[] {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? [node.id] : [];
  }
  return [
    ...getPaneIdsForSession(node.children[0], sessionId),
    ...getPaneIdsForSession(node.children[1], sessionId),
  ];
}

function removeSessionFromPaneTree(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? null : node;
  }
  const left = removeSessionFromPaneTree(node.children[0], sessionId);
  const right = removeSessionFromPaneTree(node.children[1], sessionId);
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

function layoutUsesOnlyCanonicalShellSessions(layout: TerminalLayout): boolean {
  if (!Array.isArray(layout.tabs) || layout.tabs.length === 0) {
    return false;
  }
  const sessionIds = layout.tabs.flatMap((tab) => getSessionIds(tab.paneTree));
  return sessionIds.length > 0 && sessionIds.every((sessionId) => isCanonicalShellSessionId(sessionId));
}

function getCanonicalShellSessionIds(layout: TerminalLayout): string[] {
  if (!Array.isArray(layout.tabs)) {
    return [];
  }
  const seen = new Set<string>();
  for (const tab of layout.tabs) {
    for (const sessionId of getSessionIds(tab.paneTree)) {
      if (isCanonicalShellSessionId(sessionId)) {
        seen.add(sessionId);
      }
    }
  }
  return Array.from(seen);
}

function destroyTerminalSessions(sessionIds: string[]) {
  const uniqueIds = Array.from(new Set(sessionIds.filter((sessionId) => sessionId.length > 0)));
  for (const sessionId of uniqueIds) {
    const isCanonical = isCanonicalShellSessionId(sessionId);
    const isLegacyPty = isLegacyPtySessionId(sessionId);
    if (!isCanonical && !isLegacyPty) {
      continue;
    }
    const path = isCanonical
      ? `/api/terminal/sessions/${encodeURIComponent(sessionId)}?force=1`
      : `/api/terminal/pty-sessions/${encodeURIComponent(sessionId)}`;
    void fetch(`${getGatewayUrl()}${path}`, {
      method: "DELETE",
      keepalive: true,
      signal: AbortSignal.timeout(5_000),
    }).then((res) => {
      if (!res.ok && res.status !== 404) {
        console.warn(`Failed to destroy terminal session "${sessionId}" on explicit close: ${res.status}`);
      }
    }).catch((err: unknown) => {
      console.warn(
        `Failed to destroy terminal session "${sessionId}" on explicit close:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}

async function ensureShellSessions(sessionNames: string[]): Promise<boolean> {
  const requestedNames = Array.from(new Set(
    sessionNames.filter((name) => isCanonicalShellSessionId(name)),
  ));
  if (requestedNames.length === 0) {
    return true;
  }

  try {
    const listRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    const existingNames = new Set<string>();
    if (listRes.ok) {
      const data = await listRes.json() as { sessions?: Array<{ name?: unknown }> };
      if (Array.isArray(data.sessions)) {
        for (const session of data.sessions) {
          if (typeof session.name === "string") {
            existingNames.add(session.name);
          }
        }
      }
    }

    for (const name of requestedNames) {
      if (existingNames.has(name)) {
        continue;
      }
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered repair: each missing saved zellij session is recreated once before layout restore; these are user-visible session names, not a fan-out workload.
      const createRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cwd: DEFAULT_CWD }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!createRes.ok && createRes.status !== 409) {
        return false;
      }
    }

    return true;
  } catch (err: unknown) {
    console.warn("Failed to ensure terminal sessions:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function ensureDefaultShellSession(): Promise<boolean> {
  return ensureShellSessions([DEFAULT_SHELL_SESSION_NAME]);
}

async function getFirstOrderedShellSessionName(): Promise<string | null> {
  try {
    const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json() as { sessions?: Array<{ name?: unknown; status?: unknown }> };
    if (!Array.isArray(data.sessions)) {
      return null;
    }
    for (const session of data.sessions) {
      if (typeof session.name === "string" && isCanonicalShellSessionId(session.name) && session.status !== "exited") {
        return session.name;
      }
    }
    return null;
  } catch (err: unknown) {
    console.warn("Failed to load ordered shell sessions:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function ensureInitialShellSession(): Promise<string | null> {
  const firstOrdered = await getFirstOrderedShellSessionName();
  if (firstOrdered) {
    return firstOrdered;
  }
  const sessionReady = await ensureDefaultShellSession();
  return sessionReady ? DEFAULT_SHELL_SESSION_NAME : null;
}

function mapTerminalThemeToShellTheme(themeId: TerminalThemeId | undefined): ShellThemeId {
  if (themeId === "dark" || themeId === "light" || themeId === "matrix") {
    return themeId;
  }
  if (themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light") {
    return "light";
  }
  return "dark";
}

let globalShellThemePreferenceLoadStarted = false;

function loadGlobalShellThemePreference(setThemeId: (themeId: TerminalThemeId) => void): void {
  if (typeof fetch !== "function") {
    return;
  }
  if (globalShellThemePreferenceLoadStarted) {
    return;
  }
  globalShellThemePreferenceLoadStarted = true;
  void fetch(`${getGatewayUrl()}/api/terminal/preferences`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => res.ok ? res.json() : null)
    .then((data: unknown) => {
      if (!data || typeof data !== "object" || !("preferences" in data)) {
        return;
      }
      const next = (data as { preferences?: { shellThemeId?: unknown } }).preferences?.shellThemeId;
      if (next === "dark" || next === "light" || next === "matrix") {
        setThemeId(next);
      }
    })
    .catch((err: unknown) => {
      globalShellThemePreferenceLoadStarted = false;
      console.warn("Failed to load shell theme preferences:", err instanceof Error ? err.message : err);
    });
}

function terminalAppDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][app]", event, details);
}

const countPanes = countPanesFromStore;

function clampTerminalSidebarWidth(width: number): number {
  return Math.min(MAX_TERMINAL_SIDEBAR_WIDTH, Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(width)));
}

export interface TerminalWindowControls {
  close?: () => void;
  minimize?: () => void;
  toggleFullscreen?: () => void;
  dragHandleProps?: TerminalWindowDragHandleProps;
}

interface TerminalWindowDragHandleProps {
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
}

interface TerminalAppProps {
  initialCommand?: string;
  initialLabel?: string;
  initialClaudeMode?: boolean;
  initialSessionId?: string;
  launchTargetId?: string;
  mobile?: boolean;
  windowControls?: TerminalWindowControls;
  /**
   * Render without the terminal's own dark title bar (traffic lights +
   * breadcrumb), because the host window already supplies a generic window.
   * Desktop terminal chrome is intentionally suppressed; mobile keeps a small
   * drawer toggle bar for usability.
   */
  embeddedChrome?: boolean;
  /**
   * CSS transform scale applied to the canvas ancestor. Forwarded to each
   * TerminalPane so its pointer-event correction can unscale xterm's
   * mouse-to-cell mapping. Defaults to 1 (no correction needed).
   */
  canvasZoom?: number;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal shell component; extraction tracked separately. prefer-useReducer: the 6 useState fields are independent, not one related cluster: tabs/activeTabId/focusedPaneId are mutated through many distinct code paths (split, close, rename, reorder, session-attach) using nested functional updaters that read prev and call sibling setters, while sidebarOpen/sidebarSelectedPath are sidebar UI and initialized is a one-time bootstrap gate; a single reducer would not be a mechanical, behavior-identical change.
export function TerminalApp({ initialCommand, initialLabel, initialClaudeMode = false, initialSessionId, launchTargetId, mobile = false, windowControls, embeddedChrome = false, canvasZoom = 1 }: TerminalAppProps = {}) {
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const appThemeId = useTerminalSettings((s) => s.appThemeId);
  const appThemeOption = getTerminalAppThemeOption(appThemeId);
  const appChromeTheme = getTerminalAppChromeTheme(appThemeOption.id);
  const appChromeCssVars = getTerminalAppChromeCssVars(appChromeTheme);

  // Keep terminal content aligned with the active shell theme. App chrome is
  // intentionally terminal-scoped and uses the separate app theme below.
  const terminalPreset = themeId === "system" ? null : getTerminalThemePreset(themeId);
  const terminalContentBackground =
    themeId === "system"
      ? (theme.colors.background || "var(--background)")
      : terminalPreset?.background ?? "var(--background)";
  const terminalChromeBackground = appChromeTheme.chromeBackground;
  const terminalChromeForeground = appChromeTheme.chromeForeground;
  const terminalChromeAccent = appChromeTheme.chromeAccent;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_TERMINAL_SIDEBAR_WIDTH);
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `tabs`, read synchronously inside stable callbacks/effects that must not re-subscribe when tabs change; writing in render keeps the mirror current
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `activeTabId`, read synchronously inside stable callbacks/effects that must not re-subscribe when the active tab changes
  activeTabIdRef.current = activeTabId;
  const initialMobileRef = useRef(mobile);
  const sidebarOpenRef = useRef(sidebarOpen);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `sidebarOpen`, read synchronously inside the layout-persistence callback that must not re-subscribe when the sidebar toggles
  sidebarOpenRef.current = sidebarOpen;
  const mountedRef = useRef(false);
  const pendingPaneSessionsRef = useRef<Map<string, string> | null>(null);
  if (pendingPaneSessionsRef.current === null) pendingPaneSessionsRef.current = new Map();
  const closingPaneIdsRef = useRef<Set<string> | null>(null);
  if (closingPaneIdsRef.current === null) closingPaneIdsRef.current = new Set();
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalLayoutHydratedRef = useRef(false);
  const terminalLayoutDirtyRef = useRef(false);
  const markTerminalLayoutDirty = () => {
    terminalLayoutDirtyRef.current = true;
  };
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `log` is consumed in the dependency array of the tabs-changed useEffect below; removing the memo would re-create it every render and re-run that effect.
  const log = useCallback((event: string, details: Record<string, unknown> = {}) => {
    terminalAppDebug(event, {
      activeTabId: activeTabIdRef.current,
      focusedPaneId,
      tabIds: tabsRef.current.map((tab) => tab.id),
      ...details,
    });
  }, [focusedPaneId]);

  const persistLayoutNow = () => {
    const layout: TerminalLayout = {
      tabs: tabsRef.current,
      activeTabId: activeTabIdRef.current,
      ...(initialMobileRef.current ? {} : { sidebarOpen: sidebarOpenRef.current }),
    };

    return fetch(`${getGatewayUrl()}/api/terminal/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(layout),
      keepalive: true,
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save terminal layout:", err instanceof Error ? err.message : err);
    });
  };

  const getPendingSessionIds = (paneIds: string[]) => {
    const seen = new Set<string>();
    for (const paneId of paneIds) {
      const sessionId = pendingPaneSessionsRef.current!.get(paneId);
      if (sessionId) {
        seen.add(sessionId);
      }
    }
    return Array.from(seen);
  };

  const markPanesClosing = (paneIds: string[]) => {
    for (const paneId of paneIds) {
      closingPaneIdsRef.current!.add(paneId);
    }
    setTimeout(() => {
      for (const paneId of paneIds) {
        closingPaneIdsRef.current!.delete(paneId);
      }
    }, 0);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadGlobalShellThemePreference(setThemeId);
  }, [setThemeId]);

  const addTab = (cwd: string, label?: string, claude?: boolean, startupCommand?: string, sessionId?: string) => {
    const id = genId();
    const paneId = genId();
    const basename = cwd.split("/").filter(Boolean).pop() ?? "~";
    const tab: Tab = {
      id,
      label: label ?? basename,
      paneTree: {
        type: "pane",
        id: paneId,
        cwd,
        claudeMode: claude,
        startupCommand,
        sessionId,
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  };

  const addSessionTab = (label: string, sessionId: string, cwd = DEFAULT_CWD) => {
    const id = genId();
    const paneId = genId();
    const tab: Tab = {
      id,
      label,
      paneTree: {
        type: "pane",
        id: paneId,
        cwd,
        sessionId,
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  };

  const createShellSessionTab = async (
    label: string,
    cwd = DEFAULT_CWD,
    options: { namePrefix?: string; cmd?: string } = {},
  ) => {
    let requestedCwd = cwd || "~";
    let retriedHomeCwd = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = terminalSessionName(options.namePrefix);
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential-by-design retry loop: each attempt only runs if the prior one failed with a 409 name collision or abort; parallelizing would create multiple sessions
        const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, cwd: requestedCwd, ...(options.cmd ? { cmd: options.cmd } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 409) {
          continue;
        }
        if (!res.ok) {
          if (!retriedHomeCwd && res.status === 400 && await readShellErrorCode(res) === "invalid_cwd") {
            retriedHomeCwd = true;
            requestedCwd = "~";
            attempt -= 1;
            continue;
          }
          console.warn(`Failed to create shell session "${name}": ${res.status}`);
          return null;
        }
        if (!mountedRef.current) {
          destroyTerminalSessions([name]);
          return null;
        }
        const data = await res.json() as { name?: unknown };
        const sessionName = typeof data.name === "string" ? data.name : name;
        addSessionTab(label, sessionName, requestedCwd);
        return sessionName;
      } catch (err: unknown) {
        console.warn(
          "Failed to create shell session:",
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof Error && err.name === "AbortError") {
          continue;
        }
        return null;
      }
    }
    console.warn("Failed to create shell session: name collision");
    return null;
  };

  const backgroundShellSession = (sessionId: string) => {
    const next = tabs.filter((tab) => !getSessionIds(tab.paneTree).includes(sessionId));
    const nextActiveTabId = next.some((tab) => tab.id === activeTabId) ? activeTabId : next[0]?.id ?? "";
    const nextFocusedPaneId =
      focusedPaneId && next.some((tab) => hasPaneId(tab.paneTree, focusedPaneId))
        ? focusedPaneId
        : next[0]
          ? getFirstPaneId(next[0].paneTree)
          : null;

    setTabs(next);
    setActiveTabId(nextActiveTabId);
    setFocusedPaneId(nextFocusedPaneId);
  };

  const removeDeletedShellSessionFromLayout = (sessionId: string) => {
    const paneIds = tabsRef.current.flatMap((tab) => getPaneIdsForSession(tab.paneTree, sessionId));
    if (paneIds.length === 0) {
      return;
    }
    markPanesClosing(paneIds);
    setTabs((prev) => {
      const next = prev
        .map((tab) => {
          const paneTree = removeSessionFromPaneTree(tab.paneTree, sessionId);
          return paneTree ? { ...tab, paneTree } : null;
        })
        .filter((tab): tab is Tab => tab !== null);
      tabsRef.current = next;
      setActiveTabId((current) => next.some((tab) => tab.id === current) ? current : next[0]?.id ?? "");
      setFocusedPaneId((current) => {
        if (current && next.some((tab) => hasPaneId(tab.paneTree, current))) {
          return current;
        }
        return next[0] ? getFirstPaneId(next[0].paneTree) : null;
      });
      return next;
    });
  };

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one-time mount bootstrap that loads the saved terminal layout from the gateway; the fetch is AbortSignal-guarded and every state write is gated behind a `cancelled` flag cleared in cleanup, so this is an intentional mount-driven load, not render data
  useEffect(() => {
    let cancelled = false;

    async function initLayout() {
      if (initialCommand) {
        addTab(DEFAULT_CWD, initialLabel ?? "Terminal", initialClaudeMode, initialCommand);
        if (!cancelled) setInitialized(true);
        return;
      }

      if (initialSessionId) {
        addTab(DEFAULT_CWD, "Canvas Terminal", false, undefined, initialSessionId);
        if (!cancelled) setInitialized(true);
        return;
      }

      try {
        const res = await fetch(`${getGatewayUrl()}/api/terminal/layout`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json() as TerminalLayout;
          if (!cancelled && Array.isArray(data.tabs) && data.tabs.length > 0) {
            if (layoutUsesOnlyCanonicalShellSessions(data)) {
              const sessionReady = await ensureShellSessions(getCanonicalShellSessionIds(data));
              if (!cancelled && sessionReady) {
                const nextActiveTabId = data.activeTabId ?? data.tabs[0].id;
                const nextActiveTab = data.tabs.find((tab) => tab.id === nextActiveTabId) ?? data.tabs[0];
                setTabs(data.tabs);
                setActiveTabId(nextActiveTabId);
                setSidebarOpen(initialMobileRef.current ? false : data.sidebarOpen ?? true);
                setFocusedPaneId(nextActiveTab ? getFirstPaneId(nextActiveTab.paneTree) : null);
                setInitialized(true);
                return;
              }
            }

            const sessionName = await ensureInitialShellSession();
            if (!cancelled && sessionName) {
              addSessionTab(formatShellDisplayName(sessionName), sessionName);
              setInitialized(true);
              return;
            }
          }
        }
      } catch (err: unknown) {
        console.warn("Failed to load terminal layout:", err instanceof Error ? err.message : err);
      }

      if (!cancelled) {
        const sessionName = await ensureInitialShellSession();
        if (!cancelled) {
          if (sessionName) {
            addSessionTab(formatShellDisplayName(sessionName), sessionName);
          } else {
            addTab(DEFAULT_CWD);
          }
          setInitialized(true);
        }
      }
    }

    void initLayout();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional run-once mount bootstrap: re-running on any prop/callback change would re-initialize tabs and clobber the user's live terminal layout. The props (initialCommand/initialLabel/initialClaudeMode/initialSessionId) are mount-time inputs and addTab/addSessionTab are stable.
  }, []);

  const drainLaunches = useEffectEvent((event?: Event) => {
    const eventTargetId = event instanceof CustomEvent ? event.detail?.targetId : undefined;
    if (typeof eventTargetId === "string" && eventTargetId !== launchTargetId) return;
    for (const launch of drainTerminalLaunchQueue(launchTargetId)) {
      addTab(DEFAULT_CWD, launch.label, launch.claudeMode, launch.command);
    }
  });

  useEffect(() => {
    if (!initialized) {
      return;
    }

    const handleLaunch = (event: Event) => drainLaunches(event);

    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- drains the external terminal-launch queue (module-level state populated by other shells) once it is ready; the resulting tabs are not derivable in render, so this is a legitimate external-source drain, not adjusted-from-props state
    drainLaunches();
    window.addEventListener(TERMINAL_LAUNCH_EVENT, handleLaunch);
    return () => window.removeEventListener(TERMINAL_LAUNCH_EVENT, handleLaunch);
  }, [initialized, launchTargetId]);

  const flushLayout = useEffectEvent(() => {
    void persistLayoutNow();
  });

  useEffect(() => {
    if (!initialized) {
      return;
    }

    if (!terminalLayoutHydratedRef.current) {
      terminalLayoutHydratedRef.current = true;
      if (!terminalLayoutDirtyRef.current) return;
    }
    terminalLayoutDirtyRef.current = true;

    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }

    layoutSaveTimerRef.current = setTimeout(() => {
      layoutSaveTimerRef.current = null;
      flushLayout();
      terminalLayoutDirtyRef.current = false;
    }, 500);

    return () => {
      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }
    };
  }, [initialized, activeTabId, sidebarOpen, tabs]);

  useEffect(() => {
    const flushOnPageHide = () => {
      if (!initialized) {
        return;
      }
      if (!terminalLayoutDirtyRef.current) {
        return;
      }

      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }

      flushLayout();
      terminalLayoutDirtyRef.current = false;
    };

    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [initialized]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Read the live value via ref (not a dep) so the observer is created once.
    // Depending on `sidebarOpen` recreated the observer on every toggle, and a
    // fresh observe() fires an immediate callback that snapped a just-expanded
    // sidebar shut in a narrow terminal — making the expand/minimize toggle
    // appear broken. Now it only collapses on an actual narrow resize.
    const observer = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) < 500 && sidebarOpenRef.current) setSidebarOpen(false);
    });
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- false positive: observing the container may synchronously deliver the current size, but it only closes an already-open sidebar when the measured terminal width is narrow
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const closeTab = (tabId: string) => {
    const closingTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (closingTab) {
      const paneIds = getAllPaneIds(closingTab.paneTree);
      destroyTerminalSessions([
        ...getSessionIds(closingTab.paneTree),
        ...getPendingSessionIds(paneIds),
      ]);
      markPanesClosing(paneIds);
    }
    log("close-tab", {
      tabId,
      paneIds: tabsRef.current.find((tab) => tab.id === tabId)?.paneTree ? getAllPaneIds(tabsRef.current.find((tab) => tab.id === tabId)!.paneTree) : [],
    });
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      setActiveTabId(curr => {
        if (curr !== tabId) return curr;
        const idx = prev.findIndex(t => t.id === tabId);
        return next[Math.min(idx, next.length - 1)]?.id ?? "";
      });
      return next;
    });
  };

  const splitPane = (paneId: string, dir: "horizontal" | "vertical") => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId || countPanes(t.paneTree) >= 4) return t;
      return { ...t, paneTree: splitPaneInTree(t.paneTree, paneId, dir) };
    }));
  };

  const closePane = (paneId: string) => {
    const activeTabRecord = tabsRef.current.find((tab) => tab.id === activeTabId);
    const closingSessionIds = new Set<string>();
    const closingSessionId = activeTabRecord ? getPaneSessionId(activeTabRecord.paneTree, paneId) : null;
    if (closingSessionId) closingSessionIds.add(closingSessionId);
    const pendingSessionId = pendingPaneSessionsRef.current!.get(paneId);
    if (pendingSessionId) closingSessionIds.add(pendingSessionId);
    destroyTerminalSessions(Array.from(closingSessionIds));
    markPanesClosing([paneId]);
    log("close-pane", { paneId });
    setTabs(prev => {
      const tab = prev.find(t => t.id === activeTabId);
      if (!tab) return prev;
      const newTree = closePaneInTree(tab.paneTree, paneId);
      if (!newTree) {
        const next = prev.filter(t => t.id !== activeTabId);
        setActiveTabId(next[0]?.id ?? "");
        setFocusedPaneId(null);
        return next;
      }
      setFocusedPaneId(getFirstPaneId(newTree));
      return prev.map(t => t.id === activeTabId ? { ...t, paneTree: newTree } : t);
    });
  };

  const renameTab = (tabId: string, label: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t));
  };

  const renameShellSession = (fromSessionId: string, toSessionId: string) => {
    setTabs(prev => {
      const nextTabs = prev.map((tab) => {
        const nextTree = renameSessionInTree(tab.paneTree, fromSessionId, toSessionId);
        const nextLabel =
          tab.label === fromSessionId || tab.label === formatShellDisplayName(fromSessionId)
            ? formatShellDisplayName(toSessionId)
            : tab.label;
        return nextTree === tab.paneTree && nextLabel === tab.label
          ? tab
          : { ...tab, label: nextLabel, paneTree: nextTree };
      });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  };

  const reorderTabs = (from: number, to: number) => {
    setTabs(prev => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  };

  const getCwd = () => sidebarSelectedPath ?? DEFAULT_CWD;

  const handleSessionAttached = (paneId: string, sessionId: string) => {
    log("session-attached", { paneId, sessionId });
    pendingPaneSessionsRef.current!.set(paneId, sessionId);
    setTabs((prev) => {
      const nextTabs = prev.map((tab) => {
        const nextTree = setPaneSessionId(tab.paneTree, paneId, sessionId);
        return nextTree === tab.paneTree ? tab : { ...tab, paneTree: nextTree };
      });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  };

  const shouldCachePane = (paneId: string) => {
    const keep = !closingPaneIdsRef.current!.has(paneId) && tabsRef.current.some((tab) => hasPaneId(tab.paneTree, paneId));
    log("should-cache-pane", {
      paneId,
      keep,
      tabs: tabsRef.current.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
    return keep;
  };

  const shouldDestroyPane = (paneId: string) => {
    return closingPaneIdsRef.current!.has(paneId);
  };

  useEffect(() => {
    const livePaneIds = new Set<string>();
    for (const tab of tabs) {
      for (const paneId of getAllPaneIds(tab.paneTree)) {
        livePaneIds.add(paneId);
      }
    }
    for (const paneId of Array.from(pendingPaneSessionsRef.current!.keys())) {
      if (!livePaneIds.has(paneId)) {
        pendingPaneSessionsRef.current!.delete(paneId);
      }
    }

    log("tabs-changed", {
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
  }, [log, tabs]);

  useEffect(() => {
    if (!initialized) return undefined;
    const resizeTimer = window.setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 220);
    return () => window.clearTimeout(resizeTimer);
  }, [activeTabId, initialized, sidebarOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    switch (e.key.toUpperCase()) {
      case "T": e.preventDefault(); markTerminalLayoutDirty(); void createShellSessionTab("Shell", getCwd()); break;
      case "W": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); closePane(focusedPaneId); } break;
      case "D": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); splitPane(focusedPaneId, "horizontal"); } break;
      case "E": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); splitPane(focusedPaneId, "vertical"); } break;
      case "B": e.preventDefault(); markTerminalLayoutDirty(); setSidebarOpen(o => !o); break;
      case "C": e.preventDefault(); markTerminalLayoutDirty(); addTab(getCwd(), "Claude Code", true); break;
      case "Z": e.preventDefault(); markTerminalLayoutDirty(); void createShellSessionTab("Shell", getCwd()); break;
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Construct store-compatible interface for child components
  const storeApi = {
    tabs, activeTabId, sidebarOpen, sidebarWidth, sidebarSelectedPath, focusedPaneId, mobile, windowControls,
    terminalBackground: appChromeTheme.drawerBorder,
    addTab: (...args: Parameters<typeof addTab>) => {
      markTerminalLayoutDirty();
      return addTab(...args);
    },
    addSessionTab: (...args: Parameters<typeof addSessionTab>) => {
      markTerminalLayoutDirty();
      return addSessionTab(...args);
    },
    createShellSessionTab: (...args: Parameters<typeof createShellSessionTab>) => {
      markTerminalLayoutDirty();
      return createShellSessionTab(...args);
    },
    backgroundShellSession: (...args: Parameters<typeof backgroundShellSession>) => {
      markTerminalLayoutDirty();
      return backgroundShellSession(...args);
    },
    removeDeletedShellSessionFromLayout: (...args: Parameters<typeof removeDeletedShellSessionFromLayout>) => {
      markTerminalLayoutDirty();
      return removeDeletedShellSessionFromLayout(...args);
    },
    closeTab: (...args: Parameters<typeof closeTab>) => {
      markTerminalLayoutDirty();
      return closeTab(...args);
    },
    setActiveTab: (tabId: string) => {
      markTerminalLayoutDirty();
      setActiveTabId(tabId);
    },
    renameTab: (...args: Parameters<typeof renameTab>) => {
      markTerminalLayoutDirty();
      return renameTab(...args);
    },
    renameShellSession: (...args: Parameters<typeof renameShellSession>) => {
      markTerminalLayoutDirty();
      return renameShellSession(...args);
    },
    reorderTabs: (...args: Parameters<typeof reorderTabs>) => {
      markTerminalLayoutDirty();
      return reorderTabs(...args);
    },
    splitPane: (...args: Parameters<typeof splitPane>) => {
      markTerminalLayoutDirty();
      return splitPane(...args);
    },
    closePane: (...args: Parameters<typeof closePane>) => {
      markTerminalLayoutDirty();
      return closePane(...args);
    },
    setFocusedPane: (paneId: string | null) => {
      markTerminalLayoutDirty();
      setFocusedPaneId(paneId);
    },
    setSidebarOpen: (value: React.SetStateAction<boolean>) => {
      markTerminalLayoutDirty();
      setSidebarOpen(value);
    },
    setSidebarWidth,
    setSidebarSelectedPath,
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full"
      style={{
        ...appChromeCssVars,
        background: "var(--terminal-app-window-bg)",
        color: "var(--terminal-chrome-fg)",
      }}
      role="application"
      aria-label="Terminal"
      onKeyDown={handleKeyDown}
    >
      <style>{SHELL_STATUS_DOT_CSS}</style>
      <TerminalAppContext.Provider value={storeApi}>
        {mobile ? (embeddedChrome ? <TerminalEmbeddedToolbar /> : <TerminalWorkspaceChrome />) : null}
        <div
          className={mobile ? "relative flex flex-1 min-h-0 flex-col" : "relative flex flex-1 min-h-0"}
          style={{ background: "var(--terminal-app-body-bg)" }}
        >
          <LocalTerminalSidebar />
          {activeTab ? (
            <div
              data-testid="terminal-content-surface"
              className="flex-1 min-w-0 min-h-0 flex"
              style={{
                padding: 0,
                background: terminalContentBackground,
                minHeight: mobile ? 0 : undefined,
              }}
            >
              <div className="flex flex-1 min-h-0 min-w-0 flex-col">
                <PaneGrid
                  paneTree={activeTab.paneTree}
                  theme={theme}
                  focusedPaneId={focusedPaneId}
                  onFocusPane={setFocusedPaneId}
                  onSessionAttached={handleSessionAttached}
                  shouldCachePane={shouldCachePane}
                  shouldDestroyPane={shouldDestroyPane}
                  allowRemoteResize={!mobile}
                  suppressNativeKeyboard={mobile}
                  canvasZoom={canvasZoom}
                />
                {mobile && (
                  <>
                    <MobileTerminalActions
                      defaultCwd={DEFAULT_CWD}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                    />
                    <MobileCommandComposer
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                    />
                    <TerminalKeyBar
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                    />
                  </>
                )}
              </div>
            </div>
          ) : !initialized ? (
            <div className="flex-1" style={{ background: "var(--background)" }} />
          ) : (
            <div className="flex-1 flex items-center justify-center" style={{ color: "var(--muted-foreground)" }}>
              <div className="text-center">
                <p className="text-sm mb-2">No terminal tabs open</p>
                <button
                  type="button"
                  className="text-xs px-3 py-1.5 rounded cursor-pointer"
                  style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                  onClick={() => { void createShellSessionTab("Shell", DEFAULT_CWD); }}
                >
                  New Terminal
                </button>
              </div>
            </div>
          )}
        </div>
      </TerminalAppContext.Provider>
    </div>
  );
}

// ---- Context for local state ----

interface TerminalAppContextType {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;
  mobile: boolean;
  windowControls?: TerminalWindowControls;
  terminalBackground: string;
  addTab: (cwd: string, label?: string, claude?: boolean, startupCommand?: string) => string;
  addSessionTab: (label: string, sessionId: string, cwd?: string) => string;
  createShellSessionTab: (label: string, cwd?: string, options?: { namePrefix?: string; cmd?: string }) => Promise<string | null>;
  backgroundShellSession: (sessionId: string) => void;
  removeDeletedShellSessionFromLayout: (sessionId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  renameShellSession: (fromSessionId: string, toSessionId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  splitPane: (paneId: string, dir: "horizontal" | "vertical") => void;
  closePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  setSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSidebarWidth: (width: number | ((prev: number) => number)) => void;
  setSidebarSelectedPath: (path: string | null) => void;
}

const TerminalAppContext = createContext<TerminalAppContextType | null>(null);

function useTerminalAppContext() {
  const ctx = use(TerminalAppContext);
  if (!ctx) throw new Error("Must be inside TerminalApp");
  return ctx;
}

// ---- Local versions of TabBar and Sidebar that use context instead of global store ----

const ICON_SIZE = 16;

function IconPlus() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
interface ToolbarBtnProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  variant?: "default" | "primary" | "success";
  ariaLabel?: string;
}
function ToolbarBtn({ onClick, title, children, variant = "default", ariaLabel }: ToolbarBtnProps) {
  const colors =
    variant === "success"
      ? { bg: "var(--success)", color: "white", border: "transparent" }
      : variant === "primary"
        ? { bg: "var(--primary)", color: "white", border: "transparent" }
        : { bg: "transparent", color: "var(--muted-foreground)", border: "transparent" };
  return (
    <button
      type="button"
      className="cursor-pointer transition-colors flex items-center justify-center gap-1.5"
      style={{
        ...TOOLBAR_BTN_BASE_STYLE,
        padding: variant === "default" ? "0 6px" : "0 10px",
        fontWeight: variant === "default" ? 400 : 500,
        background: colors.bg,
        color: colors.color,
        border: `1px solid ${colors.border}`,
      }}
      onMouseEnter={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "var(--accent)";
          e.currentTarget.style.color = "var(--foreground)";
        } else {
          e.currentTarget.style.opacity = "0.85";
        }
      }}
      onMouseLeave={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted-foreground)";
        } else {
          e.currentTarget.style.opacity = "1";
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function ThemePickerButton({ menuPlacement = "below-end" }: { menuPlacement?: ThemeMenuPlacement }) {
  const ctx = useTerminalAppContext();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [themeMenuView, setThemeMenuView] = useState<"app" | "shell">("app");
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeThemeMenu = () => {
    setThemeMenuOpen(false);
    setThemeMenuView("app");
  };
  const closeThemeMenuEvent = useEffectEvent(closeThemeMenu);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeThemeMenuEvent();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeThemeMenuEvent();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [themeMenuOpen]);

  const openThemeMenu = () => {
    if (themeMenuOpen) {
      closeThemeMenu();
      return;
    }
    setThemeMenuView("app");
    setThemeMenuOpen(true);
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative" }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Theme"
        title="Theme"
        style={PAPER_THEME_BUTTON_STYLE}
        onClick={openThemeMenu}
      >
        <span style={{ color: "#CF7835", fontSize: 17, fontWeight: 600, lineHeight: "22px" }}>☼</span>
        <span>Theme</span>
      </button>
      {themeMenuOpen && themeMenuView === "app" ? (
        <TerminalAppThemeMenu
          mobile={ctx.mobile}
          placement={menuPlacement}
          onClose={closeThemeMenu}
          onOpenShellTheme={() => setThemeMenuView("shell")}
        />
      ) : null}
      {themeMenuOpen && themeMenuView === "shell" ? (
        <ShellThemeChooser
          mobile={ctx.mobile}
          placement={menuPlacement}
          onBack={() => setThemeMenuView("app")}
          onClose={closeThemeMenu}
        />
      ) : null}
    </div>
  );
}

function TerminalAppThemeMenu({
  mobile,
  placement,
  onClose,
  onOpenShellTheme,
}: {
  mobile: boolean;
  placement: ThemeMenuPlacement;
  onClose: () => void;
  onOpenShellTheme: () => void;
}) {
  const appThemeId = useTerminalSettings((s) => s.appThemeId);
  const setAppThemeId = useTerminalSettings((s) => s.setAppThemeId);

  const chooseAppTheme = (next: TerminalAppThemeId) => {
    setAppThemeId(next);
    onClose();
  };

  if (mobile) {
    return (
      <dialog
        aria-label="Theme"
        aria-modal="true"
        open
        style={TERMINAL_THEME_MOBILE_DIALOG_STYLE}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <button
          type="button"
          aria-label="Dismiss theme menu"
          tabIndex={-1}
          onClick={onClose}
          style={TERMINAL_THEME_MENU_DISMISS_STYLE}
        />
        <div
          role="menu"
          aria-label="Theme"
          style={TERMINAL_THEME_MOBILE_SHEET_STYLE}
        >
          <div style={{ alignItems: "center", display: "flex", justifyContent: "center", paddingBottom: 4 }}>
            <div style={{ background: "#D6D5C4", borderRadius: 999, height: 5, width: 42 }} />
          </div>
          <div style={{ color: "#2A2E22", fontFamily: "Inter, system-ui, sans-serif", fontSize: 19, fontWeight: 700, lineHeight: "24px" }}>
            Theme
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {MATRIX_OS_APP_THEME_OPTIONS.map((option) => (
              <TerminalAppThemeMenuItem
                key={option.id}
                mobile
                option={option}
                selected={option.id === appThemeId}
                onClick={() => chooseAppTheme(option.id)}
              />
            ))}
          </div>
          <div style={{ background: "#E4E2D2", height: 1 }} />
          <ChangeShellThemeMenuItem mobile onClick={onOpenShellTheme} />
          <div style={{ alignItems: "center", display: "flex", justifyContent: "center", paddingBottom: 9, paddingTop: 8 }}>
            <div style={{ background: "#1F221B", borderRadius: 999, height: 5, width: 140 }} />
          </div>
        </div>
      </dialog>
    );
  }

  return (
    <div
      role="menu"
      aria-label="Theme"
      style={{
        ...TERMINAL_THEME_DESKTOP_MENU_STYLE,
        ...getTerminalThemeDesktopMenuPositionStyle(placement),
      }}
    >
      <div style={{ padding: "8px 10px 4px" }}>
        <div style={{ color: "#6F7167", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", lineHeight: "15px", textTransform: "uppercase" }}>
          Theme
        </div>
      </div>
      {MATRIX_OS_APP_THEME_OPTIONS.map((option) => (
        <TerminalAppThemeMenuItem
          key={option.id}
          option={option}
          selected={option.id === appThemeId}
          onClick={() => chooseAppTheme(option.id)}
        />
      ))}
      <div style={{ background: "#2A2E22", height: 1, margin: "4px 8px" }} />
      <ChangeShellThemeMenuItem onClick={onOpenShellTheme} />
    </div>
  );
}

function TerminalAppThemeMenuItem({
  mobile = false,
  option,
  selected,
  onClick,
}: {
  mobile?: boolean;
  option: TerminalAppThemeOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      aria-label={`${option.label} ${option.description}`}
      onClick={onClick}
      style={getTerminalThemeMenuItemStyle(mobile, selected)}
    >
      <TerminalAppThemePreview option={option} mobile={mobile} />
      <span style={TERMINAL_THEME_MENU_ITEM_TEXT_STYLE}>
        <span style={{ color: mobile ? "#2A2E22" : "#F0EFE5", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 16 : 14, fontWeight: 600, lineHeight: mobile ? "20px" : "18px" }}>
          {option.label}
        </span>
        <span style={{ color: "#858578", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 13 : 12, lineHeight: "16px" }}>
          {option.description}
        </span>
      </span>
      {selected ? <CheckIcon size={mobile ? 20 : 18} strokeWidth={2.4} style={{ color: mobile ? "#4F8A55" : "#9CB77A", flexShrink: 0 }} /> : null}
    </button>
  );
}

function TerminalAppThemePreview({
  option,
  mobile,
}: {
  option: TerminalAppThemeOption;
  mobile: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={getTerminalThemePreviewStyle(option, mobile)}
    >
      <span style={{ background: option.preview.stripe, borderRadius: 2, display: "block", height: 3, width: mobile ? 22 : 18 }} />
      <span style={{ display: "flex", gap: mobile ? 4 : 3 }}>
        <span style={{ background: option.preview.dotA, borderRadius: 999, display: "block", height: mobile ? 7 : 6, width: mobile ? 7 : 6 }} />
        <span style={{ background: option.preview.dotB, borderRadius: 999, display: "block", height: mobile ? 7 : 6, width: mobile ? 7 : 6 }} />
      </span>
    </span>
  );
}

function ChangeShellThemeMenuItem({
  mobile = false,
  onClick,
}: {
  mobile?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label="Change shell theme Advanced terminal colors"
      onClick={onClick}
      style={getChangeShellThemeMenuItemStyle(mobile)}
    >
      <span
        aria-hidden="true"
        style={getChangeShellThemeIconStyle(mobile)}
      >
        <SquareTerminalIcon size={mobile ? 18 : 16} strokeWidth={2} />
      </span>
      <span style={TERMINAL_THEME_MENU_ITEM_TEXT_STYLE}>
        <span style={{ color: mobile ? "#5F6258" : "#858578", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 15 : 13, fontWeight: 600, lineHeight: mobile ? "18px" : "16px" }}>
          Change shell theme
        </span>
        <span style={{ color: mobile ? "#A09F92" : "#5F6258", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, lineHeight: mobile ? "16px" : "15px" }}>
          Advanced · terminal colors
        </span>
      </span>
      <ChevronRightIcon size={mobile ? 18 : 16} strokeWidth={2} style={{ color: mobile ? "#A09F92" : "#5F6258", flexShrink: 0 }} />
    </button>
  );
}

function ShellThemeChooser({
  mobile,
  placement,
  onBack,
  onClose,
}: {
  mobile: boolean;
  placement: ThemeMenuPlacement;
  onBack: () => void;
  onClose: () => void;
}) {
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const selectedShellThemeId = mapTerminalThemeToShellTheme(themeId);

  const persistShellTheme = (next: ShellThemeId) => {
    setThemeId(next);
    if (typeof fetch !== "function") {
      return;
    }
    const state = useTerminalSettings.getState();
    void fetch(`${getGatewayUrl()}/api/terminal/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shellThemeId: next,
        fontFamily: state.fontFamily,
        ligatures: state.ligatures,
        cursorStyle: state.cursorStyle,
        smoothScroll: state.smoothScroll,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save shell theme preferences:", err instanceof Error ? err.message : err);
    });
  };

  const content = (
    <ShellThemeChooserContent
      mobile={mobile}
      onBack={onBack}
      onSelectTheme={persistShellTheme}
      selectedShellThemeId={selectedShellThemeId}
    />
  );

  if (mobile) {
    return (
      <dialog
        aria-label="Theme"
        aria-modal="true"
        open
        style={TERMINAL_THEME_MOBILE_DIALOG_STYLE}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <style>{TERMINAL_SHELL_THEME_MOTION_CSS}</style>
        <button
          type="button"
          aria-label="Dismiss theme menu"
          tabIndex={-1}
          onClick={onClose}
          style={TERMINAL_THEME_MENU_DISMISS_STYLE}
        />
        <section
          aria-label="Shell theme"
          data-terminal-shell-theme-motion
          data-testid="terminal-shell-theme-panel"
          style={{
            ...TERMINAL_THEME_MOBILE_SHEET_STYLE,
            ...getShellThemePanelMotionStyle(true),
          }}
        >
          {content}
        </section>
      </dialog>
    );
  }

  return (
    <>
      <style>{TERMINAL_SHELL_THEME_MOTION_CSS}</style>
      <section
        aria-label="Shell theme"
        data-terminal-shell-theme-motion
        data-testid="terminal-shell-theme-panel"
        style={{
          ...TERMINAL_SHELL_THEME_DESKTOP_PANEL_STYLE,
          ...getTerminalThemeDesktopMenuPositionStyle(placement),
          ...getShellThemePanelMotionStyle(false),
        }}
      >
        {content}
      </section>
    </>
  );
}

function ShellThemeChooserContent({
  mobile,
  onBack,
  onSelectTheme,
  selectedShellThemeId,
}: {
  mobile: boolean;
  onBack: () => void;
  onSelectTheme: (next: ShellThemeId) => void;
  selectedShellThemeId: ShellThemeId;
}) {
  return (
    <>
      {mobile ? (
        <div style={{ alignSelf: "center", background: "#D4D4C4", borderRadius: 999, height: 5, width: 42 }} />
      ) : null}
      <div style={mobile ? TERMINAL_SHELL_THEME_MOBILE_HEADER_STYLE : TERMINAL_SHELL_THEME_DESKTOP_HEADER_STYLE}>
        <button
          type="button"
          aria-label="Back to theme menu"
          onClick={onBack}
          style={{
            alignItems: "center",
            background: mobile ? "#F4F3E9" : "var(--terminal-chrome-control-bg)",
            border: `1px solid ${mobile ? "#E4E2D2" : "var(--terminal-chrome-control-border)"}`,
            borderRadius: mobile ? 10 : 8,
            color: mobile ? "#5F6258" : "var(--terminal-chrome-control-fg)",
            cursor: "pointer",
            display: "flex",
            flexShrink: 0,
            height: mobile ? 38 : 32,
            justifyContent: "center",
            width: mobile ? 38 : 32,
          }}
        >
          <ChevronLeftIcon size={mobile ? 19 : 17} strokeWidth={2.2} />
        </button>
        <ShellThemeHeaderIcon mobile={mobile} />
        <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ color: mobile ? "#20241C" : "var(--terminal-chrome-fg)", fontSize: mobile ? 17 : 14, fontWeight: 800, lineHeight: mobile ? "22px" : "18px" }}>
            Shell theme
          </span>
          <span style={{ color: mobile ? "#77786C" : "var(--terminal-chrome-muted)", fontSize: mobile ? 12 : 11, lineHeight: mobile ? "16px" : "14px" }}>
            {mobile
              ? "Terminal colors. We recommend Dark."
              : "Terminal colors. Dark reads best for agent output, diffs, and status."}
          </span>
        </span>
      </div>

      <div role="radiogroup" aria-label="Shell theme options" style={{ display: "flex", flexDirection: "column", gap: mobile ? 9 : 7 }}>
        {SHELL_THEME_OPTIONS.map((option, index) => {
          const selected = option.id === selectedShellThemeId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} ${option.description}`}
              data-terminal-shell-theme-motion
              onClick={() => onSelectTheme(option.id)}
              style={{
                ...getShellThemeOptionStyle(mobile, selected),
                ...getShellThemeOptionMotionStyle(index),
              }}
            >
              <ShellThemePreviewIcon option={option} mobile={mobile} />
              <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: mobile ? "#20241C" : "var(--terminal-chrome-fg)", fontSize: mobile ? 14 : 13, fontWeight: 800, lineHeight: "18px" }}>
                  {option.label}
                </span>
                <span style={{ color: mobile ? "#77786C" : "var(--terminal-chrome-muted)", fontSize: mobile ? 11 : 10, lineHeight: mobile ? "15px" : "13px" }}>
                  {option.description}
                </span>
              </span>
              <span style={getShellThemeOptionTrailingStyle(mobile)}>
                <span data-terminal-shell-theme-motion style={getShellThemeBadgeStyle(option.badgeTone, mobile, index)}>
                  {option.badge}
                </span>
                {selected ? (
                  <span data-terminal-shell-theme-motion style={getShellThemeCheckStyle(mobile, index)}>
                    <CheckIcon
                      size={mobile ? 18 : 16}
                      strokeWidth={2.5}
                      style={{ color: mobile ? "#4F8A55" : "var(--terminal-chrome-active)", display: "block" }}
                    />
                  </span>
                ) : (
                  <span aria-hidden="true" style={{ flexShrink: 0, height: mobile ? 18 : 16, width: mobile ? 18 : 16 }} />
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div style={getShellThemeWarningStyle(mobile)}>
        <span aria-hidden="true" style={{ background: mobile ? "#D2B35F" : "#D2A23C", borderRadius: 999, flexShrink: 0, width: 3 }} />
        <span>
          {mobile
            ? "Light & Matrix aren't fully tuned — some colors lose contrast. Switch back to Dark if output looks off."
            : "Light and Matrix aren't fully tuned — some terminal colors lose contrast. Switch back to Dark if output looks off."}
        </span>
      </div>

      {mobile ? (
        <div style={{ alignItems: "center", display: "flex", height: 18, justifyContent: "center" }}>
          <div style={{ background: "#000000", borderRadius: 999, height: 5, width: 140 }} />
        </div>
      ) : null}
    </>
  );
}

function getShellThemePanelMotionStyle(mobile: boolean): CSSProperties {
  return {
    animation: `${mobile ? "terminalShellThemeMobilePanelIn" : "terminalShellThemePanelIn"} 180ms cubic-bezier(0.16, 1, 0.3, 1) both`,
    transformOrigin: mobile ? "bottom center" : "top right",
  };
}

function getShellThemeOptionMotionStyle(index: number): CSSProperties {
  return {
    animation: `terminalShellThemeRowIn 220ms cubic-bezier(0.16, 1, 0.3, 1) ${45 + index * 35}ms both`,
  };
}

function getShellThemeOptionStyle(mobile: boolean, selected: boolean): CSSProperties {
  if (mobile) {
    return {
      alignItems: "center",
      background: selected ? "#F4F3E9" : "#FFFDF7",
      border: `1px solid ${selected ? "#D6D5C4" : "#E9E6D8"}`,
      borderRadius: 14,
      color: "#2F332C",
      cursor: "pointer",
      display: "flex",
      gap: 13,
      minHeight: 58,
      padding: "10px 12px",
      textAlign: "left",
      width: "100%",
    };
  }

  return {
    alignItems: "center",
    background: selected ? "rgba(57, 255, 106, 0.08)" : "rgba(255, 255, 255, 0.02)",
    border: `1px solid ${selected ? "var(--terminal-chrome-active)" : "var(--terminal-chrome-control-border)"}`,
    borderRadius: 10,
    color: "var(--terminal-chrome-fg)",
    cursor: "pointer",
    display: "flex",
    gap: 12,
    minHeight: 58,
    padding: "10px 12px",
    textAlign: "left",
    width: "100%",
  };
}

function getShellThemeOptionTrailingStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    gap: mobile ? 9 : 10,
    justifyContent: "flex-end",
    minWidth: mobile ? 116 : 132,
  };
}

function getShellThemeBadgeStyle(badgeTone: "recommended" | "warning", mobile: boolean, index: number): CSSProperties {
  const recommended = badgeTone === "recommended";
  return {
    animation: `terminalShellThemeBadgeIn 300ms cubic-bezier(0.19, 1, 0.22, 1) ${95 + index * 45}ms both`,
    background: recommended ? (mobile ? "#DDEBCE" : "rgba(156, 183, 122, 0.2)") : (mobile ? "#F4E4A8" : "rgba(210, 162, 60, 0.2)"),
    borderRadius: 6,
    color: recommended ? (mobile ? "#4F8A55" : "#A8D27C") : (mobile ? "#A06F1D" : "#E2BC62"),
    fontSize: mobile ? 9 : 8,
    fontWeight: 800,
    letterSpacing: "0.01em",
    lineHeight: mobile ? "14px" : "13px",
    padding: mobile ? "2px 7px" : "2px 6px",
    transformOrigin: "center right",
    whiteSpace: "nowrap",
  };
}

function getShellThemeCheckStyle(mobile: boolean, index: number): CSSProperties {
  return {
    alignItems: "center",
    animation: `terminalShellThemeCheckIn 180ms cubic-bezier(0.16, 1, 0.3, 1) ${145 + index * 45}ms both`,
    display: "flex",
    flexShrink: 0,
    height: mobile ? 18 : 16,
    justifyContent: "center",
    width: mobile ? 18 : 16,
  };
}

function getShellThemeWarningStyle(mobile: boolean): CSSProperties {
  return {
    background: mobile ? "#F7F1E2" : "rgba(210, 162, 60, 0.12)",
    border: `1px solid ${mobile ? "#ECE2C6" : "rgba(210, 162, 60, 0.28)"}`,
    borderRadius: mobile ? 9 : 10,
    color: mobile ? "#8A7B52" : "#D4B570",
    display: "flex",
    fontSize: mobile ? 10 : 11,
    gap: 10,
    lineHeight: mobile ? "14px" : "16px",
    padding: mobile ? "10px 12px" : "11px 12px",
  };
}

function ShellThemeHeaderIcon({ mobile }: { mobile: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: "#050A06",
        border: "1px solid rgba(57, 255, 106, 0.48)",
        borderRadius: mobile ? 11 : 9,
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.05), 0 0 18px rgba(57, 255, 106, 0.14)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: mobile ? 5 : 4,
        height: mobile ? 40 : 34,
        justifyContent: "center",
        width: mobile ? 40 : 34,
      }}
    >
      <span style={{ background: "#39FF6A", borderRadius: 999, display: "block", height: 3, width: mobile ? 21 : 18 }} />
      <span style={{ display: "flex", gap: 4 }}>
        <span style={{ background: "#27E9A4", borderRadius: 999, display: "block", height: mobile ? 6 : 5, width: mobile ? 6 : 5 }} />
        <span style={{ background: "#E6E678", borderRadius: 999, display: "block", height: mobile ? 6 : 5, width: mobile ? 6 : 5 }} />
      </span>
    </span>
  );
}

function ShellThemePreviewIcon({
  option,
  mobile,
}: {
  option: (typeof SHELL_THEME_OPTIONS)[number];
  mobile: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: option.preview.background,
        border: `1px solid ${option.preview.border}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: mobile ? 5 : 4,
        height: mobile ? 32 : 28,
        justifyContent: "center",
        width: mobile ? 36 : 34,
      }}
    >
      <span style={{ background: option.preview.line, borderRadius: 2, display: "block", height: 3, width: mobile ? 16 : 15 }} />
      <span style={{ display: "flex", gap: 3 }}>
        <span style={{ background: option.preview.dotA, borderRadius: 999, display: "block", height: 5, width: 5 }} />
        <span style={{ background: option.preview.dotB, borderRadius: 999, display: "block", height: 5, width: 5 }} />
      </span>
    </span>
  );
}

function isTerminalChromeControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button,input,textarea,select,a,[role='button']"));
}

function TerminalWorkspaceChrome() {
  const ctx = useTerminalAppContext();
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId);
  const activeName = activeTab?.label === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : activeTab?.label ?? "Terminal";
  const dragHandleProps = ctx.windowControls?.dragHandleProps;
  const handleDragPointerDownCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onPointerDown?.(event);
  };
  const handleDragMouseDownCapture: MouseEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onMouseDown?.(event);
  };
  const handleDragDoubleClick: MouseEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onDoubleClick?.(event);
  };

  return (
    <div
      className="shrink-0 select-none"
      onPointerDownCapture={handleDragPointerDownCapture}
      onPointerMove={dragHandleProps?.onPointerMove}
      onPointerUp={dragHandleProps?.onPointerUp}
      onPointerCancel={dragHandleProps?.onPointerCancel}
      onMouseDownCapture={handleDragMouseDownCapture}
      onDoubleClick={handleDragDoubleClick}
      style={{
        alignItems: "center",
        background: "var(--terminal-chrome-bg)",
        borderBottom: "1px solid var(--terminal-chrome-border)",
        color: "var(--terminal-chrome-fg)",
        display: "flex",
        height: ctx.mobile ? 52 : 54,
        justifyContent: "space-between",
        padding: ctx.mobile ? "0 12px" : "0 20px",
        minWidth: 0,
        cursor: dragHandleProps && !ctx.mobile ? "grab" : undefined,
        touchAction: dragHandleProps && !ctx.mobile ? "none" : undefined,
      }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: ctx.mobile ? 10 : 16 }}>
        {!ctx.mobile && (
          <>
            <div className="flex shrink-0 items-center" style={{ gap: 9 }}>
              <TerminalTrafficButton
                label="Close Terminal window"
                color="#E8796B"
                onClick={ctx.windowControls?.close}
              />
              <TerminalTrafficButton
                label="Minimize Terminal window"
                color="#E5BE5F"
                onClick={ctx.windowControls?.minimize}
              />
              <TerminalTrafficButton
                label="Toggle Terminal fullscreen"
                color="#77B861"
                onClick={ctx.windowControls?.toggleFullscreen}
              />
            </div>
            <span style={{ background: "var(--terminal-chrome-control-border)", height: 22, width: 1 }} />
          </>
        )}
        {ctx.mobile ? (
          <button
            type="button"
            aria-label={ctx.sidebarOpen ? "Hide sessions" : "Back to sessions"}
            onClick={() => ctx.setSidebarOpen((open) => !open)}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: "var(--terminal-chrome-fg)",
              cursor: "pointer",
              display: "flex",
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            <PanelLeftOpenIcon size={18} strokeWidth={1.9} />
          </button>
        ) : null}
        <div className="flex min-w-0 items-center" style={{ gap: 10, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          <span style={{ color: "var(--terminal-chrome-muted)", fontSize: 15, lineHeight: "20px" }}>matrix-os</span>
          {!ctx.mobile && <span style={{ color: "var(--terminal-chrome-subtle)", fontSize: 15 }}>/</span>}
          <span className="truncate" style={{ color: "var(--terminal-chrome-active)", fontSize: 15, fontWeight: 700, lineHeight: "20px" }}>
            {activeName}
          </span>
          {!ctx.mobile && (
            <span
              className="inline-flex shrink-0 items-center"
              style={{
                background: "var(--terminal-chrome-badge-bg)",
                border: "1px solid var(--terminal-chrome-badge-border)",
                borderRadius: 8,
                boxSizing: "border-box",
                color: "var(--terminal-chrome-muted)",
                fontSize: 11,
                gap: 5,
                height: 22,
                lineHeight: "14px",
                overflow: "hidden",
                padding: "0 8px",
              }}
            >
              main
            </span>
          )}
        </div>
      </div>
      <span aria-hidden="true" style={{ width: ctx.mobile ? 40 : 0 }} />
    </div>
  );
}

/**
 * Slim terminal toolbar used when the host window already renders a generic
 * window header (Developer mode). It drops the redundant traffic lights and
 * breadcrumb and keeps only the terminal-specific controls — split and theme —
 * so the window reads like every other app window while staying fully featured.
 */
function TerminalEmbeddedToolbar() {
  const ctx = useTerminalAppContext();
  return (
    <div
      className="shrink-0 select-none flex items-center justify-between"
      style={{
        background: "var(--terminal-chrome-bg)",
        borderBottom: "1px solid var(--terminal-chrome-border)",
        color: "var(--terminal-chrome-fg)",
        height: ctx.mobile ? 44 : 40,
        padding: "0 10px",
        minWidth: 0,
      }}
    >
      {ctx.mobile ? (
        <button
          type="button"
          aria-label={ctx.sidebarOpen ? "Hide sessions" : "Back to sessions"}
          onClick={() => ctx.setSidebarOpen((open) => !open)}
          style={{
            alignItems: "center",
            background: "transparent",
            border: 0,
            color: "var(--terminal-chrome-fg)",
            cursor: "pointer",
            display: "flex",
            height: 36,
            justifyContent: "center",
            width: 36,
          }}
        >
          <PanelLeftOpenIcon size={18} strokeWidth={1.9} />
        </button>
      ) : <span />}
      <span aria-hidden="true" style={{ width: ctx.mobile ? 36 : 0 }} />
    </div>
  );
}

function TerminalTrafficButton({
  label,
  color,
  onClick,
}: {
  label: string;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: color,
        border: 0,
        borderRadius: 999,
        cursor: "pointer",
        height: 13,
        padding: 0,
        width: 13,
      }}
    />
  );
}

function LocalTerminalTabBar({ defaultCwd }: { defaultCwd: string }) {
  const ctx = useTerminalAppContext();
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const newTabButton = (
    <ToolbarBtn
      onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
      title="New tab (Ctrl+Shift+T)"
      ariaLabel="New tab"
    >
      <IconPlus />
    </ToolbarBtn>
  );

  return (
    <div
      className="grid items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: ctx.mobile ? 50 : 44,
        padding: "4px 6px",
        gap: 4,
        gridTemplateColumns: ctx.mobile ? "1fr" : "minmax(0, 1fr) auto",
        minWidth: 0,
      }}
    >
      <div
        className="flex items-stretch overflow-x-auto min-w-0"
        role="tablist"
        aria-label="Terminal tabs"
        style={{
          gap: 3,
          scrollbarWidth: "thin",
          overscrollBehaviorX: "contain",
        }}
      >
        {ctx.tabs.map((tab, i) => {
          const active = tab.id === ctx.activeTabId;
          const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.target !== e.currentTarget) return;

            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              ctx.setActiveTab(tab.id);
              return;
            }

            const keyToIndex: Record<string, number> = {
              ArrowLeft: i === 0 ? ctx.tabs.length - 1 : i - 1,
              ArrowRight: i === ctx.tabs.length - 1 ? 0 : i + 1,
              Home: 0,
              End: ctx.tabs.length - 1,
            };
            const nextIndex = keyToIndex[e.key];
            const nextTab = ctx.tabs[nextIndex];
            if (!nextTab) return;

            e.preventDefault();
            ctx.setActiveTab(nextTab.id);
            const tabs = Array.from(
              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
            );
            tabs[nextIndex]?.focus();
          };
          const tabNode = (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              style={{
                ...TAB_ITEM_BASE_STYLE,
                background: active ? "var(--background)" : "color-mix(in srgb, var(--background) 42%, transparent)",
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                border: `1px solid ${active ? "var(--primary)" : "color-mix(in srgb, var(--border) 55%, transparent)"}`,
                padding: ctx.mobile ? "0 7px" : "0 8px",
                fontWeight: active ? 750 : 450,
                flex: ctx.mobile ? "0 1 148px" : "0 1 168px",
                minWidth: ctx.mobile ? 96 : 108,
                maxWidth: ctx.mobile ? 160 : 190,
                boxShadow: active ? "inset 0 -3px 0 var(--primary), 0 0 0 1px color-mix(in srgb, var(--primary) 28%, transparent)" : "none",
              }}
              draggable
              onClick={() => ctx.setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown}
              onDragStart={() => { dragIndexRef.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragIndexRef.current !== null && dragIndexRef.current !== i) ctx.reorderTabs(dragIndexRef.current, i); dragIndexRef.current = null; }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                  borderRadius: "50%",
                  background: active ? "var(--success)" : "var(--muted-foreground)",
                  opacity: active ? 1 : 0.5,
                }}
              />
              <span
                className="min-w-0 truncate"
                style={{ flex: "1 1 auto", overflow: "hidden" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tab.label}</span>
              </span>
              {active && (
                <span
                  aria-hidden="true"
                  style={ACTIVE_TAB_PILL_STYLE}
                >
                  Active
                </span>
              )}
              <button
                type="button"
                className="cursor-pointer flex items-center justify-center transition-colors"
                onClick={(e) => { e.stopPropagation(); ctx.closeTab(tab.id); }}
                style={TAB_CLOSE_BUTTON_STYLE}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.5"; e.currentTarget.style.background = "transparent"; }}
                aria-label="Close tab"
                title="Close tab"
              >
                <IconClose />
                <span className="sr-only">x</span>
              </button>
            </div>
          );
          return tabNode;
        })}
        {newTabButton}
      </div>
      {!ctx.mobile && (
      <div
        className="flex items-center shrink-0"
        style={{
          gap: 4,
          paddingLeft: 8,
          borderLeft: "1px solid var(--border)",
          minWidth: 0,
        }}
      >
          <>
            <ToolbarBtn
              onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
              title="Launch Claude Code (Ctrl+Shift+C)"
              variant="success"
            >
              Claude
            </ToolbarBtn>
            <ToolbarBtn
              onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
              title="Launch Shell (Ctrl+Shift+Z)"
              variant="primary"
            >
              Shell
            </ToolbarBtn>
            <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
            <ThemePickerButton />
          </>
      </div>
      )}
    </div>
  );
}

function MobileTerminalActions({
  defaultCwd,
  background,
  foreground,
  accent,
}: {
  defaultCwd: string;
  background: string;
  foreground: string;
  accent: string;
}) {
  const ctx = useTerminalAppContext();
  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const focusedPaneId = ctx.focusedPaneId;
  const actionBackground = `color-mix(in srgb, ${foreground} 9%, transparent)`;
  const actionBorder = `color-mix(in srgb, ${foreground} 18%, transparent)`;

  return (
    <div
      data-testid="terminal-mobile-actions"
      role="toolbar"
      aria-label="Mobile terminal actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        overflowX: "auto",
        padding: "6px 2px 4px",
        background,
        borderTop: `1px solid ${actionBorder}`,
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        flexShrink: 0,
      }}
    >
      <MobileActionButton
        label="Shell"
        title="Open mobile shell"
        icon={<TerminalIcon size={14} strokeWidth={1.8} />}
        onClick={() => { void ctx.createShellSessionTab("Mobile Shell", getCwd()); }}
        background={accent}
        foreground="var(--primary-foreground)"
        border="transparent"
      />
      <MobileActionButton
        label="Pane"
        title="Split pane below"
        icon={<Rows2Icon size={14} strokeWidth={1.8} />}
        onClick={() => { if (focusedPaneId) ctx.splitPane(focusedPaneId, "vertical"); }}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
      <MobileActionButton
        label="Tab"
        title="Open terminal tab"
        icon={<PlusIcon size={14} strokeWidth={1.8} />}
        onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
      <MobileActionButton
        label="Cmd"
        title="Open Claude Code"
        icon={<KeyboardIcon size={14} strokeWidth={1.8} />}
        onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
      <MobileActionButton
        label="Paste"
        title="Paste clipboard"
        icon={<ClipboardPasteIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "paste")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={62}
      />
      <MobileActionButton
        label="Search"
        title="Search terminal"
        icon={<SearchIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "search")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={66}
      />
    </div>
  );
}

function MobileActionButton({
  label,
  title,
  icon,
  onClick,
  background,
  foreground,
  border,
  minWidth = 56,
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  background: string;
  foreground: string;
  border: string;
  minWidth?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        height: 32,
        minWidth,
        padding: "0 5px",
        borderRadius: 7,
        border: `1px solid ${border}`,
        background,
        color: foreground,
        fontSize: 11,
        fontWeight: 650,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
        touchAction: "manipulation",
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MobileCommandComposer({
  onSend,
  background,
  foreground,
  accent,
}: {
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  accent: string;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const command = value.trim();
    if (!command) return;
    onSend(`${command}\r`);
    setValue("");
  };
  const border = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  return (
    <form
      aria-label="Mobile command composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{
        alignItems: "center",
        background,
        borderTop: `1px solid ${border}`,
        display: "flex",
        flexShrink: 0,
        gap: 7,
        padding: "8px 7px",
      }}
    >
      <input
        aria-label="Command composer"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Type command..."
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        style={{
          background: `color-mix(in srgb, ${foreground} 8%, transparent)`,
          border: `1px solid ${border}`,
          borderRadius: 9,
          color: foreground,
          flex: "1 1 auto",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 13,
          height: 36,
          minWidth: 0,
          padding: "0 10px",
        }}
      />
      <button
        type="submit"
        aria-label="Send command"
        style={{
          background: accent,
          border: "1px solid transparent",
          borderRadius: 9,
          color: "#15180F",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 800,
          height: 36,
          padding: "0 13px",
        }}
      >
        Send
      </button>
    </form>
  );
}

interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  dirtyCount: number;
  modified: string | null;
}

type SidebarTab = "projects" | "shells" | "sessions" | "files";
type NewSessionMenuAnchor = "drawer" | "rail";

interface WorkspaceSessionSummary {
  id: string;
  kind?: "shell" | "agent";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  agent?: "claude" | "codex" | "opencode" | "pi";
  runtime?: {
    status?: string;
  };
  status?: string;
  nativeAttachCommand?: string[];
  transcriptPath?: string;
}

type TerminalAgentId = "claude" | "codex" | "opencode" | "pi";

interface TerminalAgentOption {
  id: TerminalAgentId;
  label: string;
  color: string;
  logoSrc: string;
  shortcut?: string;
  launchCommand?: string;
  installPackage: string;
  installFlags?: string[];
  claudeMode?: boolean;
  fallbackInstalled: boolean;
}

interface TerminalAgentStatus {
  id: TerminalAgentId;
  installed: boolean;
}

const TERMINAL_AGENT_OPTIONS: TerminalAgentOption[] = [
  {
    id: "claude",
    label: "Claude Code",
    color: "#D8792C",
    logoSrc: "/agent-logos/claude-code.png",
    shortcut: "⌘⇧C",
    installPackage: "@anthropic-ai/claude-code@latest",
    claudeMode: true,
    fallbackInstalled: true,
  },
  {
    id: "codex",
    label: "Codex",
    color: "#465243",
    logoSrc: "/agent-logos/codex.png",
    shortcut: "⌘⇧X",
    launchCommand: "codex",
    installPackage: "@openai/codex@latest",
    fallbackInstalled: true,
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#111111",
    logoSrc: "/agent-logos/opencode-white.png",
    launchCommand: "opencode",
    installPackage: "opencode-ai@latest",
    fallbackInstalled: false,
  },
  {
    id: "pi",
    label: "Pi",
    color: "#1E2F5C",
    logoSrc: "/agent-logos/pi-coding-agent.png",
    launchCommand: "pi",
    installPackage: "@earendil-works/pi-coding-agent@latest",
    installFlags: ["--ignore-scripts"],
    fallbackInstalled: false,
  },
];

const TERMINAL_AGENT_LOGO_STYLE: CSSProperties = {
  alignItems: "center",
  border: "1px solid rgba(255, 255, 255, 0.56)",
  borderRadius: 7,
  boxShadow: "0 1px 0 rgba(255, 255, 255, 0.36) inset, 0 4px 9px rgba(49, 54, 45, 0.14)",
  boxSizing: "border-box",
  color: "#FFFDF7",
  display: "flex",
  flex: "0 0 22px",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 11,
  fontWeight: 900,
  height: 22,
  justifyContent: "center",
  letterSpacing: 0,
  lineHeight: "22px",
  overflow: "hidden",
  width: 22,
};

const TERMINAL_AGENT_LOGO_IMAGE_STYLE: CSSProperties = {
  display: "block",
  height: 15,
  objectFit: "contain",
  width: 15,
};

function isTerminalAgentId(value: unknown): value is TerminalAgentId {
  return value === "claude" || value === "codex" || value === "opencode" || value === "pi";
}

function parseTerminalAgentStatuses(value: unknown): TerminalAgentStatus[] {
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) {
    return [];
  }
  return value.agents
    .filter((agent): agent is { id: TerminalAgentId; installed: boolean } => (
      Boolean(agent) &&
      typeof agent === "object" &&
      isTerminalAgentId((agent as { id?: unknown }).id) &&
      typeof (agent as { installed?: unknown }).installed === "boolean"
    ))
    .map((agent) => ({ id: agent.id, installed: agent.installed }));
}

function terminalAgentInstallCommand(option: TerminalAgentOption): string {
  const flags = option.installFlags?.join(" ") ?? "";
  const extraFlags = flags ? `${flags} ` : "";
  return [
    'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
    `npm install -g ${extraFlags}--prefix "$MATRIX_NODE_PREFIX" ${option.installPackage}`,
  ].join("; ");
}

function terminalAgentVisibleInstallCommand(option: TerminalAgentOption): string {
  const command = terminalAgentInstallCommand(option);
  return `sh -lc ${shellQuote(`printf '%s\\n' ${shellQuote(command)}; ${command}; exec "\${SHELL:-sh}" -l`)}`;
}

function getShellTabCount(shell: ShellSessionSummary): number | null {
  if (!Array.isArray(shell.tabs)) return null;
  return shell.tabs.reduce((count, tab) => {
    const indexedCount = Number.isInteger(tab.idx) && tab.idx >= 0 ? tab.idx + 1 : 0;
    return Math.max(count, indexedCount);
  }, shell.tabs.length);
}

function formatShellTabCount(shell: ShellSessionSummary): string {
  const count = getShellTabCount(shell);
  if (count === null) return "tabs unknown";
  return `${count} tab${count === 1 ? "" : "s"}`;
}

function formatShellDisplayName(name: string): string {
  return name === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : name;
}

const COLLAPSED_RAIL_ITEM_SIZE = 40;

function formatCollapsedShellLabel(name: string): string {
  const normalized = formatShellDisplayName(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = normalized.split("-").filter(Boolean);
  const compact = parts.join("");
  let label = "";
  if (parts.length >= 2) {
    label = `${parts[0]?.charAt(0) ?? ""}${parts[1]?.slice(0, 2) ?? ""}`;
  } else {
    label = compact.slice(0, 3);
  }
  if (label.length >= 3) {
    return label.slice(0, 3);
  }
  const fallback = (compact || "shl").slice(label.length);
  const padded = `${label}${fallback}`;
  return padded.padEnd(3, padded.at(-1) ?? "l").slice(0, 3);
}

function shellConnectCommand(name: string): string {
  return `matrix shell connect ${name}`;
}

function shellAttachCommand(shell: ShellSessionSummary): string {
  return shellConnectCommand(shell.name);
}

function workspaceSessionsEqual(left: WorkspaceSessionSummary[], right: WorkspaceSessionSummary[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.id.localeCompare(b.id));
  const sortedRight = [...right].sort((a, b) => a.id.localeCompare(b.id));
  return sortedLeft.every((session, index) => {
    const next = sortedRight[index];
    return (
      next !== undefined &&
      session.id === next.id &&
      session.kind === next.kind &&
      session.projectSlug === next.projectSlug &&
      session.taskId === next.taskId &&
      session.worktreeId === next.worktreeId &&
      session.pr === next.pr &&
      session.agent === next.agent &&
      session.runtime?.status === next.runtime?.status &&
      session.status === next.status &&
      session.transcriptPath === next.transcriptPath &&
      (session.nativeAttachCommand ?? []).join("\u0000") === (next.nativeAttachCommand ?? []).join("\u0000")
    );
  });
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal sidebar component; extraction tracked separately. prefer-useReducer: the 16 useState fields are several independent clusters, not one related cluster: projects/shells/sessions/files each carry their own data+loading+error triplet with separate fetch lifecycles, plus orthogonal tab/filter/rootPath/tree/agent-status UI state; collapsing them into one reducer would obscure the independent update sites and would not be a mechanical, behavior-identical change.
function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [tab, setTab] = useState<SidebarTab>("shells");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellSessionSummary[]>([]);
  const [shellsAuthoritative, setShellsAuthoritative] = useState(false);
  const [shellsStale, setShellsStale] = useState(false);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const shellRefreshStateRef = useRef<ShellRefreshState>({
    shells: [],
    authoritative: false,
    stale: false,
    error: null,
  });
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for `fetchShells` and shell-tab refresh effect dependencies in compiled and test/runtime surfaces.
  const commitShellRefreshState = useCallback((nextState: ShellRefreshState) => {
    shellRefreshStateRef.current = nextState;
    setShells(nextState.shells);
    setShellsAuthoritative(nextState.authoritative);
    setShellsStale(nextState.stale);
    setShellsError(nextState.error);
  }, []);
  useEffect(() => {
    shellRefreshStateRef.current = {
      shells,
      authoritative: shellsAuthoritative,
      stale: shellsStale,
      error: shellsError,
    };
  }, [shells, shellsAuthoritative, shellsError, shellsStale]);
  const creatingShellRef = useRef(false);
  const reorderSaveCountRef = useRef(0);
  const [creatingShell, setCreatingShell] = useState(false);
  const deletingShellsRef = useRef<Set<string> | null>(null);
  if (deletingShellsRef.current === null) deletingShellsRef.current = new Set();
  const [deletingShellNames, setDeletingShellNames] = useState<string[]>([]);
  const [closeConfirmationShell, setCloseConfirmationShell] = useState<ShellSessionSummary | null>(null);
  const [newSessionMenuAnchor, setNewSessionMenuAnchor] = useState<NewSessionMenuAnchor | null>(null);
  const [backgroundSessionsExpanded, setBackgroundSessionsExpanded] = useState(true);
  const [draggingShellName, setDraggingShellName] = useState<string | null>(null);
  const [dragOverShellName, setDragOverShellName] = useState<string | null>(null);
  const [draggingShellPlacement, setDraggingShellPlacement] = useState<"active" | "background" | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<TerminalAgentId, boolean> | null>(null);
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState("");

  const selectSidebarTab = (nextTab: SidebarTab) => {
    setTab(nextTab);
    setFilter("");
  };

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchProjects` is in the dependency array of the projects-tab useEffect below.
  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/projects?root=projects`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        setProjectsError("Failed to load projects");
        setProjects([]);
        return;
      }
      const data = (await res.json()) as { projects?: ProjectInfo[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to load projects:", msg);
      setProjectsError("Could not reach gateway");
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the projects list when the Projects tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "projects") void fetchProjects();
  }, [tab, fetchProjects]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for mount-time agent status loading and explicit refresh from the new-session menu lifecycle.
  const fetchAgentStatuses = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/agents`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`Failed to load terminal agent status: ${res.status}`);
        return;
      }
      const parsed = parseTerminalAgentStatuses(await res.json());
      if (parsed.length === 0) return;
      setAgentStatuses(Object.fromEntries(
        parsed.map((agent) => [agent.id, agent.installed]),
      ) as Record<TerminalAgentId, boolean>);
    } catch (err: unknown) {
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-fetch-in-effect -- owner-scoped local gateway status probe; it is timeout-guarded and falls back to the Paper default menu state if unavailable.
    void fetchAgentStatuses();
  }, [fetchAgentStatuses]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchShells` is in the dependency array of the shells-tab load useEffect below and command handlers.
  const fetchShells = useCallback(async (options: { silent?: boolean; signal?: AbortSignal; preserveOrderDuringReorder?: boolean } = {}) => {
    const silent = options.silent === true;
    if (!silent) setShellsLoading(true);
    if (!silent) setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        signal: options.signal ?? AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (silent) {
          commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        }
        if (!silent) {
          commitShellRefreshState(applyShellRefreshFailure(
            shellRefreshStateRef.current,
            "Failed to load shells",
          ));
        }
        return;
      }
      if (options.preserveOrderDuringReorder === true && reorderSaveCountRef.current > 0) {
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      const hasSessionList = Array.isArray(data.sessions);
      const nextShells = hasSessionList ? data.sessions! : [];
      commitShellRefreshState(applyShellRefreshSuccess(
        shellRefreshStateRef.current,
        nextShells,
        hasSessionList,
      ));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (silent) {
        commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        return;
      }
      console.warn("Failed to load shell sessions:", err instanceof Error ? err.message : err);
      commitShellRefreshState(applyShellRefreshFailure(
        shellRefreshStateRef.current,
        "Could not reach gateway",
      ));
    } finally {
      if (!silent) setShellsLoading(false);
    }
  }, [commitShellRefreshState]);

  useEffect(() => {
    if (tab !== "shells") return;
    const controller = new AbortController();
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the shell-session list when the Shells tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    void fetchShells({ signal: controller.signal });
    const refreshTimer = window.setInterval(() => {
      void fetchShells({ silent: true, signal: controller.signal, preserveOrderDuringReorder: true });
    }, SHELLS_REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [fetchShells, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchSessions` is in the dependency array of the sessions-tab useEffect below.
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions?limit=100`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to load sessions");
        setSessions([]);
        return;
      }
      const data = (await res.json()) as { sessions?: WorkspaceSessionSummary[] };
      const nextSessions = Array.isArray(data.sessions)
        ? data.sessions.filter((session) => typeof session.id === "string" && session.id.length > 0)
        : [];
      setSessions((prev) => workspaceSessionsEqual(prev, nextSessions) ? prev : nextSessions);
    } catch (err: unknown) {
      console.warn("Failed to load workspace sessions:", err instanceof Error ? err.message : err);
      setSessionsError("Could not reach gateway");
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the workspace-session list when the Sessions tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "sessions") void fetchSessions();
  }, [fetchSessions, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchDir` is in the dependency array of the files-tab useEffect below.
  const fetchDir = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/files/tree?path=${encodeURIComponent(path)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      return res.json();
    } catch (err: unknown) {
      console.warn("Failed to load terminal directory tree:", err instanceof Error ? err.message : err);
      return [];
    }
  }, []);

  useEffect(() => {
    if (tab !== "files") return;
    fetchDir(rootPath).then((entries: TreeNode[]) => setTree(entries.map(e => ({ ...e, path: `${rootPath}/${e.name}` }))));
  }, [rootPath, fetchDir, tab]);

  const toggleExpand = async (node: TreeNode) => {
    if (node.type !== "directory") return;
    if (node.expanded) { setTree(prev => updateNode(prev, node.path, { expanded: false })); return; }
    const children = await fetchDir(node.path);
    setTree(prev => updateNode(prev, node.path, { expanded: true, children: children.map((c: TreeNode) => ({ ...c, path: `${node.path}/${c.name}` })) }));
  };

  const isAtRoot = !rootPath || rootPath === ".";
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredProjects = normalizedFilter
    ? projects.filter((p) => p.name.toLowerCase().includes(normalizedFilter))
    : projects;
  const filteredShells = normalizedFilter
    ? shells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : shells;
  const filteredSessions = normalizedFilter
    ? sessions.filter((session) => [
      session.id,
      session.projectSlug,
      session.taskId,
      session.worktreeId,
      session.agent,
      session.runtime?.status,
      session.status,
      session.transcriptPath,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : sessions;
  const filteredTree = normalizedFilter ? filterTreeNodes(tree, normalizedFilter) : tree;

  const createManagedShell = async () => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async create flow is correct as written
    try {
      const name = await ctx.createShellSessionTab("Shell", ctx.sidebarSelectedPath ?? DEFAULT_CWD);
      if (name) {
        await fetchShells();
      } else {
        setShellsError("Failed to create shell");
      }
    } catch (err: unknown) {
      console.warn("Failed to create shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create shell");
    } finally {
      creatingShellRef.current = false;
      setCreatingShell(false);
    }
  };

  const deleteManagedShell = async (name: string) => {
    if (deletingShellsRef.current!.has(name)) return;
    deletingShellsRef.current!.add(name);
    setDeletingShellNames(Array.from(deletingShellsRef.current!));
    setShellsError(null);
    const previousShells = shells;
    const deletedShell = previousShells.find((shell) => shell.name === name);
    setShells((prev) => prev.filter((shell) => shell.name !== name));
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async delete flow is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}?force=1`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to remove shell");
        setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
        return;
      }
      ctx.removeDeletedShellSessionFromLayout(name);
      await fetchShells({ silent: true });
    } catch (err: unknown) {
      console.warn("Failed to remove shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not remove shell");
      setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
    } finally {
      deletingShellsRef.current!.delete(name);
      setDeletingShellNames(Array.from(deletingShellsRef.current!));
    }
  };

  const renameManagedShell = async (shell: ShellSessionSummary, nextNameRaw: string): Promise<boolean> => {
    const nextName = nextNameRaw.trim();
    if (nextName === shell.name) return true;
    if (!SHELL_SESSION_NAME_PATTERN.test(nextName)) {
      setShellsError("Use lowercase letters, numbers, and hyphens");
      return false;
    }
    setShellsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(shell.name)}/rename`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to rename session");
        return false;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      const renamedShell: ShellSessionSummary = data.session?.name
        ? data.session
        : {
            ...shell,
            name: nextName,
            attachCommand: `mos shell attach ${nextName}`,
          };
      setShells((prev) => prev.map((item) => item.name === shell.name ? renamedShell : item));
      ctx.renameShellSession(shell.name, renamedShell.name);
      return true;
    } catch (err: unknown) {
      console.warn("Failed to rename shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not rename session");
      return false;
    }
  };

  const patchShellUiState = async (
    name: string,
    patch: ShellUiStatePatch,
    options: { rollbackOnFailure?: boolean } = {},
  ) => {
    const rollbackOnFailure = options.rollbackOnFailure ?? true;
    setShellsError(null);
    const previousValues: ShellUiStatePatch = {};
    setShells((prev) => prev.map((shell) => {
      if (shell.name !== name) return shell;
      Object.assign(previousValues, snapshotShellUiStatePatch(shell, patch));
      return applyShellUiStatePatch(shell, patch);
    }));
    const rollback = () => {
      setShells((prev) => prev.map((shell) => (
        shell.name === name
          ? rollbackShellUiStatePatch(shell, patch, previousValues)
          : shell
      )));
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}/ui-state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (rollbackOnFailure) {
          setShellsError("Failed to update session");
          rollback();
        }
        return null;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      if (data.session?.name) {
        setShells((prev) => prev.map((shell) => shell.name === data.session!.name ? data.session! : shell));
        return data.session;
      }
      return null;
    } catch (err: unknown) {
      console.warn("Failed to update shell session UI state:", err instanceof Error ? err.message : err);
      if (rollbackOnFailure) {
        setShellsError("Could not update session");
        rollback();
      }
      return null;
    }
  };

  const openWorkspaceTransport = async (session: WorkspaceSessionSummary, mode: "observe" | "takeover") => {
    if (!session.id) {
      setSessionsError("Session is missing an id");
      return;
    }
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(session.id)}/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to attach session");
        return;
      }
      const data = (await res.json()) as { terminalSessionId?: string };
      if (data.terminalSessionId) {
        ctx.addSessionTab(`${session.id} · ${mode}`, data.terminalSessionId);
      }
    } catch (err: unknown) {
      console.warn("Failed to attach workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not attach session");
    }
  };

  const duplicateWorkspaceSession = async (session: WorkspaceSessionSummary) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: session.kind ?? (session.agent ? "agent" : "shell"),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
          ...(session.taskId ? { taskId: session.taskId } : {}),
          ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
          ...(session.pr ? { pr: session.pr } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to duplicate session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to duplicate workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not duplicate session");
    }
  };

  const killWorkspaceSession = async (sessionId: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to kill session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to kill workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not kill session");
    }
  };

  const openSessionIds = new Set<string>();
  const syntheticShells: ShellSessionSummary[] = [];
  for (const terminalTab of ctx.tabs) {
    for (const sessionId of getSessionIds(terminalTab.paneTree)) {
      if (!sessionId || openSessionIds.has(sessionId)) continue;
      openSessionIds.add(sessionId);
      if (!isCanonicalShellSessionId(sessionId)) continue;
      syntheticShells.push({
        name: sessionId,
        status: "active",
        placement: "active",
        attachedClients: 1,
        tabs: [{ idx: 0, name: "main", focused: true }],
      });
    }
  }
  const syntheticFilteredShells = normalizedFilter
    ? syntheticShells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : syntheticShells;
  const unfilteredRenderedShells = shells.length > 0
    ? shells
    : shellsAuthoritative ? [] : syntheticShells;
  const renderedShells = filteredShells.length > 0
    ? filteredShells
    : shellsAuthoritative ? [] : syntheticFilteredShells;
  const activeShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "active");
  const backgroundShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "background");
  const activeTerminalTab = ctx.tabs.find((terminalTab) => terminalTab.id === ctx.activeTabId) ?? ctx.tabs[0];
  const selectedPaneId = activeTerminalTab
    ? ctx.focusedPaneId && hasPaneId(activeTerminalTab.paneTree, ctx.focusedPaneId)
      ? ctx.focusedPaneId
      : getFirstPaneId(activeTerminalTab.paneTree)
    : null;
  const activePaneSessionId = activeTerminalTab && selectedPaneId
    ? getPaneSessionId(activeTerminalTab.paneTree, selectedPaneId)
    : null;
  const activeShellName = activePaneSessionId && isCanonicalShellSessionId(activePaneSessionId)
    ? activePaneSessionId
    : null;
  const terminalDividerColor = ctx.terminalBackground || "#080A08";
  const drawerWidth = ctx.mobile ? "100%" : clampTerminalSidebarWidth(ctx.sidebarWidth);
  const startSidebarResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    event.preventDefault();
    event.stopPropagation();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startWidth = clampTerminalSidebarWidth(ctx.sidebarWidth);
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      ctx.setSidebarWidth(clampTerminalSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const finishResize = () => {
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture?.(pointerId);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  };
  const resizeSidebarWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    ctx.setSidebarWidth((width) => clampTerminalSidebarWidth(width + delta));
  };
  const openActiveShell = (shell: ShellSessionSummary, options: { markSeen?: boolean } = {}) => {
    const markSeen = options.markSeen !== false;
    const existingTab = ctx.tabs.find((tab) => getSessionIds(tab.paneTree).includes(shell.name));
    if (existingTab) {
      ctx.setActiveTab(existingTab.id);
    } else {
      ctx.addSessionTab(formatShellDisplayName(shell.name), shell.name);
    }
    if (markSeen && shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq) {
      void patchShellUiState(shell.name, { lastSeenSeq: shell.latestSeq });
    }
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const moveShellToBackground = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, { placement: "background" });
    ctx.backgroundShellSession(shell.name);
  };

  const makeShellActive = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, {
      placement: "active",
      ...(shell.latestSeq !== undefined && shell.latestSeq !== null ? { lastSeenSeq: shell.latestSeq } : {}),
    }, { rollbackOnFailure: false });
    openActiveShell(shell, { markSeen: false });
  };

  const placementForShell = (shell: ShellSessionSummary): "active" | "background" => (
    shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")
  );

  const reorderShells = async (fromName: string, toName: string) => {
    if (fromName === toName) return;
    const fromIndex = shells.findIndex((shell) => shell.name === fromName);
    const toIndex = shells.findIndex((shell) => shell.name === toName);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextShells = [...shells];
    const [moved] = nextShells.splice(fromIndex, 1);
    if (!moved) return;
    nextShells.splice(toIndex, 0, moved);
    reorderSaveCountRef.current += 1;
    setShells(nextShells);
    setShellsError(null);
    const finishReorderSave = () => {
      reorderSaveCountRef.current = Math.max(0, reorderSaveCountRef.current - 1);
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextShells.map((shell) => shell.name) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Shell order could not be saved");
        await fetchShells({ silent: true });
        finishReorderSave();
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      if (Array.isArray(data.sessions)) {
        commitShellRefreshState(applyShellRefreshSuccess(
          shellRefreshStateRef.current,
          data.sessions,
          true,
        ));
      } else {
        await fetchShells({ silent: true });
      }
      finishReorderSave();
    } catch (err: unknown) {
      console.warn("Failed to save shell order:", err instanceof Error ? err.message : err);
      setShellsError("Shell order could not be saved");
      await fetchShells({ silent: true });
      finishReorderSave();
    }
  };

  const finishShellDrag = () => {
    setDraggingShellName(null);
    setDragOverShellName(null);
    setDraggingShellPlacement(null);
  };

  const beginShellDrag = (shell: ShellSessionSummary) => {
    setDraggingShellName(shell.name);
    setDraggingShellPlacement(placementForShell(shell));
    setDragOverShellName(null);
  };

  const hoverShellDropTarget = (shell: ShellSessionSummary) => {
    if (!draggingShellName || draggingShellName === shell.name) return;
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) return;
    setDragOverShellName(shell.name);
  };

  const dropShellOnTarget = (shell: ShellSessionSummary) => {
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) {
      finishShellDrag();
      return;
    }
    if (draggingShellName && draggingShellName !== shell.name) {
      void reorderShells(draggingShellName, shell.name);
    }
    finishShellDrag();
  };

  const openNewSessionMenu = (anchor: NewSessionMenuAnchor) => {
    if (creatingShell) return;
    if (newSessionMenuAnchor !== anchor) {
      void fetchAgentStatuses();
    }
    setNewSessionMenuAnchor((current) => current === anchor ? null : anchor);
  };

  const createAgentSession = async (option: TerminalAgentOption, installed: boolean) => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    const cwd = ctx.sidebarSelectedPath ?? DEFAULT_CWD;
    try {
      const label = installed ? option.label : `Install ${option.label}`;
      const cmd = installed
        ? option.launchCommand ?? (option.claudeMode ? "claude" : undefined)
        : terminalAgentVisibleInstallCommand(option);
      const name = await ctx.createShellSessionTab(label, cwd, {
        namePrefix: option.id,
        cmd,
      });
      if (name) {
        await fetchShells({ silent: true });
      } else {
        setShellsError("Failed to create agent session");
      }
    } catch (err: unknown) {
      console.warn("Failed to create agent session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create agent session");
    }
    creatingShellRef.current = false;
    setCreatingShell(false);
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const pendingCloseShell = closeConfirmationShell
    ? unfilteredRenderedShells.find((shell) => shell.name === closeConfirmationShell.name) ?? closeConfirmationShell
    : null;
  const closeConfirmationOverlay = pendingCloseShell ? (
    <ShellCloseConfirmation
      shell={pendingCloseShell}
      mobile={ctx.mobile}
      deleting={deletingShellNames.includes(pendingCloseShell.name)}
      onCancel={() => setCloseConfirmationShell(null)}
      onConfirm={() => {
        const shellName = pendingCloseShell.name;
        setCloseConfirmationShell(null);
        void deleteManagedShell(shellName);
      }}
    />
  ) : null;

  if (!ctx.sidebarOpen && !ctx.mobile) {
    return (
      <>
        <div
          data-testid="terminal-sidebar-shell"
          className="shrink-0"
          style={{
            display: "flex",
            minHeight: 0,
            opacity: 1,
            overflow: "visible",
            transform: "translateX(0)",
            transition: TERMINAL_SIDEBAR_TRANSITION,
            width: 76,
          }}
        >
          <CollapsedSessionsRail
            shells={unfilteredRenderedShells}
            selectedShellName={activeShellName}
            terminalDividerColor={terminalDividerColor}
            onExpand={() => ctx.setSidebarOpen(true)}
            creatingShell={creatingShell}
            newSessionMenuOpen={newSessionMenuAnchor === "rail"}
            onNew={() => openNewSessionMenu("rail")}
            onNewMenuClose={() => setNewSessionMenuAnchor(null)}
            onCreateShell={() => void createManagedShell()}
            onCreateAgent={createAgentSession}
            agentStatuses={agentStatuses}
            onOpen={makeShellActive}
          />
        </div>
        {closeConfirmationOverlay}
      </>
    );
  }

  if (!ctx.sidebarOpen) {
    return closeConfirmationOverlay;
  }

  return (
    <>
      <div
        data-testid="terminal-sidebar-shell"
        className="shrink-0 overflow-hidden"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderRight: ctx.mobile ? "none" : `1px solid ${terminalDividerColor}`,
          borderBottom: ctx.mobile ? "1px solid var(--terminal-drawer-border)" : "none",
          color: "var(--terminal-drawer-fg)",
          display: "flex",
          flexDirection: "column",
          maxHeight: ctx.mobile ? "52%" : undefined,
          minHeight: ctx.mobile ? 360 : undefined,
          opacity: 1,
          overflow: "visible",
          position: "relative",
          transform: "translateX(0)",
          transition: ctx.mobile ? undefined : TERMINAL_SIDEBAR_TRANSITION,
          width: drawerWidth,
        }}
      >
      <div
        className="shrink-0"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderBottom: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: ctx.mobile ? "16px 20px" : "19px 24px 18px",
        }}
      >
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <div className="flex min-w-0 items-center" style={{ gap: 12 }}>
            <div
              data-testid="terminal-expanded-brand"
              className="flex shrink-0 items-center justify-center"
              style={{
                alignSelf: "center",
                background: "var(--terminal-drawer-brand-bg)",
                borderRadius: ctx.mobile ? 12 : 10,
                height: ctx.mobile ? 40 : 38,
                width: ctx.mobile ? 40 : 38,
              }}
            >
              <span
                aria-hidden="true"
                data-testid="terminal-expanded-brand-mask"
                style={{
                  background: "var(--terminal-drawer-brand-fg)",
                  WebkitMaskImage: "url('/matrix-logo.svg')",
                  maskImage: "url('/matrix-logo.svg')",
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                  display: "block",
                  height: ctx.mobile ? 22 : 22,
                  width: ctx.mobile ? 22 : 22,
                }}
              />
            </div>
            <div className="min-w-0">
              <div style={{ color: "var(--terminal-drawer-fg)", fontFamily: "var(--font-sans), system-ui, sans-serif", fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: "24px" }}>
                matrix os
              </div>
              {!ctx.mobile ? (
                <div className="truncate" style={{ color: "var(--terminal-drawer-muted)", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 13, lineHeight: "17px" }}>
                  {ctx.sidebarSelectedPath ? formatCwd(ctx.sidebarSelectedPath) : "~/projects"}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                aria-label="New session"
                aria-haspopup="menu"
                aria-expanded={newSessionMenuAnchor === "drawer"}
                onClick={() => openNewSessionMenu("drawer")}
                disabled={creatingShell}
                className="flex items-center justify-center"
                style={{
                  background: "var(--terminal-drawer-primary-button-bg)",
                  border: 0,
                  borderRadius: ctx.mobile ? 13 : 10,
                  color: "var(--terminal-drawer-primary-button-fg)",
                  cursor: creatingShell ? "not-allowed" : "pointer",
                  fontSize: 25,
                  height: ctx.mobile ? 44 : 40,
                  lineHeight: "28px",
                  opacity: creatingShell ? 0.72 : 1,
                  width: ctx.mobile ? 44 : 40,
                }}
              >
                <PlusIcon aria-hidden="true" size={ctx.mobile ? 20 : 18} strokeWidth={2.5} />
              </button>
              {newSessionMenuAnchor === "drawer" ? (
                <NewSessionMenu
                  align="right"
                  onClose={() => setNewSessionMenuAnchor(null)}
                  onCreateShell={() => void createManagedShell()}
                  onCreateAgent={createAgentSession}
                  agentStatuses={agentStatuses}
                />
              ) : null}
            </div>
            {!ctx.mobile && (
              <>
                <button
                  type="button"
                  aria-label="Refresh sessions"
                  onClick={() => void fetchShells()}
                  disabled={shellsLoading}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: shellsLoading ? "not-allowed" : "pointer",
                    height: 40,
                    opacity: shellsLoading ? 0.72 : 1,
                    width: 40,
                  }}
                >
                  <RefreshCwIcon
                    className={shellsLoading ? "terminal-refresh-icon--loading" : undefined}
                    data-testid="terminal-refresh-icon"
                    size={17}
                    strokeWidth={1.9}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Hide sessions drawer"
                  onClick={() => ctx.setSidebarOpen(false)}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: "pointer",
                    height: 40,
                    width: 40,
                  }}
                >
                  <ChevronsLeftIcon data-testid="terminal-drawer-collapse-icon" size={17} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        </div>
        <div
          className="flex items-center"
          style={{
            background: "var(--terminal-drawer-search-bg)",
            border: "1px solid var(--terminal-drawer-search-border)",
            borderRadius: ctx.mobile ? 14 : 10,
            gap: 10,
            height: ctx.mobile ? 48 : 40,
            padding: "0 14px",
          }}
        >
          <SearchIcon size={18} strokeWidth={1.9} color="var(--terminal-drawer-search-icon)" />
          <input
            aria-label="Search sessions"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a session..."
            style={{
              background: "transparent",
              border: 0,
              color: "var(--terminal-drawer-fg)",
              flex: 1,
              fontSize: ctx.mobile ? 16 : 15,
              minWidth: 0,
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ display: "flex", flexDirection: "column", gap: 18, padding: ctx.mobile ? 20 : 18 }}>
        {shellsLoading && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>Loading sessions...</div>
        )}
        {!shellsLoading && shellsStale && renderedShells.length > 0 && (
          <div
            data-testid="terminal-sessions-stale-label"
            style={{
              background: "#FFF7DA",
              border: "1px solid #EADFAE",
              borderRadius: 8,
              color: "#7C5A0B",
              fontSize: 12,
              lineHeight: "16px",
              padding: "9px 10px",
              textAlign: "center",
            }}
          >
            Terminal session data is stale. Retry refresh.
          </div>
        )}
        {!shellsLoading && shellsError && (
          <div style={{ color: "#8F6712", fontSize: 12, padding: "24px 0", textAlign: "center" }}>{shellsError}</div>
        )}
        {!shellsLoading && !shellsError && !creatingShell && renderedShells.length === 0 && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>
            {filter ? "No sessions match" : "No sessions yet"}
          </div>
        )}
        {!shellsLoading && (activeShells.length > 0 || creatingShell) && (
          <ShellSessionGroup
            label="Active"
            shells={activeShells}
            pending={creatingShell}
            deletingShellNames={deletingShellNames}
            foreground
            selectedShellName={activeShellName}
            onOpen={openActiveShell}
            onToggle={moveShellToBackground}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell) => setCloseConfirmationShell(shell)}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
        {!shellsLoading && renderedShells.length > 0 && (
          <ShellSessionGroup
            label="Background"
            shells={backgroundShells}
            expanded={backgroundSessionsExpanded}
            onToggleExpanded={() => setBackgroundSessionsExpanded((expanded) => !expanded)}
            deletingShellNames={deletingShellNames}
            foreground={false}
            selectedShellName={activeShellName}
            onOpen={makeShellActive}
            onToggle={makeShellActive}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell) => setCloseConfirmationShell(shell)}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
      </div>
      <div
        data-testid="terminal-sidebar-footer"
        className="shrink-0"
        style={{
          alignItems: "center",
          background: "var(--terminal-drawer-bg)",
          borderTop: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          justifyContent: "flex-start",
          padding: ctx.mobile ? "13px 20px calc(13px + env(safe-area-inset-bottom))" : "12px 18px",
        }}
      >
        <ThemePickerButton menuPlacement="above-start" />
      </div>
      {!ctx.mobile ? (
        <button
          type="button"
          aria-label="Resize sessions drawer"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          style={{
            background: terminalDividerColor,
            border: 0,
            bottom: 0,
            cursor: "col-resize",
            margin: 0,
            position: "absolute",
            right: 0,
            top: 0,
            width: 8,
            zIndex: 5,
          }}
        />
      ) : null}
    </div>
      {closeConfirmationOverlay}
    </>
  );
}

function formatCloseConfirmationMeta(shell: ShellSessionSummary): string {
  const placement = shell.placement === "background" ? "background" : "active";
  const unreadCount = typeof shell.latestSeq === "number" && typeof shell.lastSeenSeq === "number"
    ? Math.max(0, shell.latestSeq - shell.lastSeenSeq)
    : shell.unread ? 1 : 0;
  return unreadCount > 0 ? `${placement} · ${unreadCount} unread` : placement;
}

function NewSessionMenu({
  align,
  onClose,
  onCreateShell,
  onCreateAgent,
  agentStatuses,
}: {
  align: "left" | "right";
  onClose: () => void;
  onCreateShell: () => void;
  onCreateAgent: (option: TerminalAgentOption, installed: boolean) => void;
  agentStatuses: Record<TerminalAgentId, boolean> | null;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="New session menu"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: "var(--terminal-drawer-card-bg)",
        border: "1px solid var(--terminal-drawer-card-border)",
        borderRadius: 9,
        boxShadow: "0 16px 36px var(--terminal-drawer-card-shadow)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 8,
        position: "absolute",
        ...(align === "right"
          ? { right: 0, top: "calc(100% + 8px)" }
          : { left: "calc(100% + 8px)", top: 0 }),
        width: 244,
        // Sits above the collapsed rail's right divider and the terminal
        // content so the NEW TAB menu never paints behind that edge.
        zIndex: 120,
      }}
    >
      <div style={{ padding: "0 4px 1px" }}>
        <div
          style={{
            color: "var(--terminal-drawer-subtle)",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.08em",
            lineHeight: "15px",
            textTransform: "uppercase",
          }}
        >
          NEW TAB
        </div>
      </div>
      <NewSessionMenuItem
        label="Shell"
        active
        icon={(
          <TerminalIcon
            aria-hidden="true"
            size={16}
            strokeWidth={2.1}
            style={{ color: "var(--terminal-drawer-selected-stripe)", flexShrink: 0 }}
          />
        )}
        onClick={onCreateShell}
      />
      {TERMINAL_AGENT_OPTIONS.map((option) => {
        const installed = agentStatuses?.[option.id] ?? option.fallbackInstalled;
        return (
          <NewSessionMenuItem
            key={option.id}
            label={option.label}
            install={!installed}
            icon={<TerminalAgentLogo muted={!installed} option={option} />}
            onClick={() => onCreateAgent(option, installed)}
          />
        );
      })}
    </div>
  );
}

function TerminalAgentLogo({ option, muted }: { option: TerminalAgentOption; muted: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid={`terminal-agent-logo-${option.id}`}
      style={{
        ...TERMINAL_AGENT_LOGO_STYLE,
        background: option.color,
        opacity: muted ? 0.86 : 1,
      }}
    >
      <Image
        alt=""
        data-testid={`terminal-agent-logo-image-${option.id}`}
        draggable={false}
        height={17}
        src={option.logoSrc}
        style={TERMINAL_AGENT_LOGO_IMAGE_STYLE}
        width={17}
      />
    </span>
  );
}

function NewSessionMenuItem({
  label,
  icon,
  active = false,
  install = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  install?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        alignItems: "center",
        background: active ? "var(--terminal-drawer-action-bg)" : install ? "var(--terminal-drawer-card-muted-bg)" : "transparent",
        border: 0,
        borderRadius: 7,
        boxSizing: "border-box",
        color: "var(--terminal-drawer-fg)",
        cursor: "pointer",
        display: "flex",
        flexShrink: 0,
        gap: 9,
        height: 32,
        padding: "0 9px",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--terminal-drawer-action-bg)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = active ? "var(--terminal-drawer-action-bg)" : install ? "var(--terminal-drawer-card-muted-bg)" : "transparent";
      }}
    >
      {icon}
      <span
        style={{
          flex: "1 1 auto",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 13,
          fontWeight: active ? 700 : 600,
          lineHeight: "17px",
          minWidth: 0,
          color: install ? "var(--terminal-drawer-muted)" : "var(--terminal-drawer-fg)",
        }}
      >
        {label}
      </span>
      {install ? (
        <span
          style={{
            alignItems: "center",
            display: "flex",
            flexShrink: 0,
            justifyContent: "flex-end",
          }}
        >
          <span
            data-testid="terminal-agent-install-pill"
            style={{
              alignItems: "center",
              background: "var(--terminal-drawer-action-bg)",
              border: "1px solid var(--terminal-drawer-action-border)",
              borderRadius: 999,
              boxSizing: "border-box",
              color: "var(--terminal-drawer-action-fg)",
              display: "flex",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              fontWeight: 700,
              height: 18,
              lineHeight: "14px",
              padding: "0 6px",
            }}
          >
            Install
          </span>
        </span>
      ) : null}
    </button>
  );
}

function ShellCloseConfirmation({
  shell,
  mobile,
  deleting,
  onCancel,
  onConfirm,
}: {
  shell: ShellSessionSummary;
  mobile: boolean;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const displayName = formatShellDisplayName(shell.name);
  const titleId = "terminal-close-confirmation-title";
  const bodyCopy = mobile
    ? "Closing permanently deletes this session and its transcript. This can't be undone."
    : "Closing ends the session and permanently deletes it and its transcript. You won't be able to reopen or recover it — this can't be undone.";
  const sessionMeta = formatCloseConfirmationMeta(shell);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  const sheetStyle: CSSProperties = mobile
    ? {
        background: "#FFFDF7",
        borderTopLeftRadius: 26,
        borderTopRightRadius: 26,
        boxShadow: "0 -18px 50px rgba(0,0,0,0.44)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 390,
        padding: "10px 22px 0",
        width: "100%",
      }
    : {
        background: "#FFFDF7",
        border: "1px solid #E4E2D2",
        borderRadius: 12,
        boxShadow: "0 26px 64px rgba(0,0,0,0.34)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: "calc(100% - 48px)",
        padding: 16,
        width: 340,
      };
  return (
    <dialog
      open
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        alignItems: mobile ? "flex-end" : "center",
        background: "rgba(3, 10, 3, 0.74)",
        border: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        left: 0,
        margin: 0,
        maxHeight: "none",
        maxWidth: "none",
        padding: mobile ? 0 : 24,
        position: "absolute",
        right: 0,
        top: 0,
        width: "auto",
        zIndex: 40,
      }}
    >
      <button
        type="button"
        aria-label="Cancel close session"
        onClick={onCancel}
        style={{
          background: "transparent",
          border: 0,
          bottom: 0,
          cursor: "default",
          left: 0,
          padding: 0,
          position: "absolute",
          right: 0,
          top: 0,
        }}
      />
      <div data-testid="terminal-close-confirmation-sheet" style={{ ...sheetStyle, position: "relative", zIndex: 1 }}>
        {mobile ? (
          <div className="flex items-center justify-center" style={{ paddingBottom: 6 }}>
            <span style={{ background: "#D6D5C4", borderRadius: 999, height: 5, width: 42 }} />
          </div>
        ) : null}
        <div style={{ alignItems: "flex-start", display: "flex", gap: mobile ? 14 : 12 }}>
          <div
            className="flex shrink-0 items-center justify-center"
            style={{
              background: "#F0EFE5",
              border: "1px solid #DCDAC9",
              borderRadius: mobile ? 13 : 10,
              color: "#77786E",
              height: mobile ? 46 : 36,
              width: mobile ? 46 : 36,
            }}
          >
            <Trash2Icon aria-hidden="true" size={mobile ? 21 : 16} strokeWidth={2} />
          </div>
          <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: mobile ? 6 : 4, minWidth: 0, paddingTop: mobile ? 2 : 0 }}>
            <div
              id={titleId}
              style={{
                color: "#2A2E22",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 19 : 14,
                fontWeight: 700,
                lineHeight: mobile ? "24px" : "18px",
              }}
            >
              Close this session?
            </div>
            <div
              style={{
                color: "#858578",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 14 : 11,
                lineHeight: mobile ? "20px" : "15px",
              }}
            >
              {bodyCopy}
            </div>
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            background: "#F4F3E9",
            border: "1px solid #E4E2D2",
            borderRadius: mobile ? 12 : 10,
            display: "flex",
            flexShrink: 0,
            gap: mobile ? 10 : 8,
            height: mobile ? 48 : 30,
            padding: mobile ? "0 14px" : "0 10px",
          }}
        >
          <span
            className={getShellStatusDotClassName(shell)}
            aria-hidden="true"
            style={{
              ...getShellStatusDotStyle(shell),
              borderRadius: 999,
              flexShrink: 0,
              height: mobile ? 8 : 6,
              width: mobile ? 8 : 6,
            }}
          />
          <span
            className="truncate"
            style={{
              color: "#31362D",
              flex: "1 1 0%",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: mobile ? 15 : 11,
              fontWeight: 700,
              lineHeight: mobile ? "18px" : "14px",
              minWidth: 0,
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              color: "#A09F92",
              flexShrink: 0,
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: mobile ? 12 : 10,
              fontWeight: 500,
              lineHeight: mobile ? "16px" : "12px",
            }}
          >
            {sessionMeta}
          </span>
        </div>
        {mobile ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                aria-label="Delete"
                disabled={deleting}
                onClick={onConfirm}
                className="flex items-center justify-center"
                style={{
                  background: "#2A2E22",
                  border: 0,
                  borderRadius: 14,
                  color: "#F8F7EF",
                  cursor: deleting ? "not-allowed" : "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  gap: 8,
                  height: 52,
                  opacity: deleting ? 0.68 : 1,
                }}
              >
                <Trash2Icon aria-hidden="true" size={17} strokeWidth={2} />
                Delete
              </button>
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCancel}
                className="flex items-center justify-center"
                style={{
                  background: "#F0EFE5",
                  border: "1px solid #DCDAC9",
                  borderRadius: 14,
                  color: "#3E4339",
                  cursor: "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  height: 52,
                }}
              >
                Cancel
              </button>
            </div>
            <div className="flex items-center justify-center" style={{ paddingBottom: 9, paddingTop: 8 }}>
              <span style={{ background: "#1F221B", borderRadius: 999, height: 5, width: 140 }} />
            </div>
          </>
        ) : (
          <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              aria-label="Cancel"
              onClick={onCancel}
              className="flex items-center justify-center"
              style={{
                background: "#F0EFE5",
                border: "1px solid #DCDAC9",
                borderRadius: 7,
                color: "#3E4339",
                cursor: "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                height: 30,
                padding: "0 14px",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label="Delete"
              disabled={deleting}
              onClick={onConfirm}
              className="flex items-center justify-center"
              style={{
                background: "#2A2E22",
                border: 0,
                borderRadius: 7,
                color: "#F8F7EF",
                cursor: deleting ? "not-allowed" : "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                gap: 6,
                height: 30,
                opacity: deleting ? 0.68 : 1,
                padding: "0 14px",
              }}
            >
              <Trash2Icon aria-hidden="true" size={13} strokeWidth={2} />
              Delete
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

function SidebarRailButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center cursor-pointer transition-colors"
      style={{
        ...SIDEBAR_RAIL_BUTTON_BASE_STYLE,
        border: `1px solid ${active ? "var(--border)" : "transparent"}`,
        background: active ? "var(--card)" : "transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        boxShadow: active ? "0 1px 0 rgba(0,0,0,0.08)" : "none",
      }}
      title={label}
    >
      {icon}
    </button>
  );
}

function getShellVisualStatus(shell: ShellSessionSummary): NonNullable<ShellSessionSummary["visualStatus"]> {
  if (shell.visualStatus) return shell.visualStatus;
  if (shell.status === "degraded") return "waiting";
  if (shell.status === "exited") return shell.unread ? "finished" : "idle";
  return shell.unread ? "finished" : "idle";
}

function getShellStatusDotStyle(shell: ShellSessionSummary): CSSProperties {
  const status = getShellVisualStatus(shell);
  if (status === "running") {
    return { background: "#5FB85F", boxShadow: "0 0 0 4px rgba(95,184,95,0.24)" };
  }
  if (status === "waiting") {
    return { background: "#E0A12E", boxShadow: "0 0 0 4px rgba(224,161,46,0.25)" };
  }
  if (status === "finished") {
    return { background: "#2E6B3A", boxShadow: "none" };
  }
  return { background: "#A9AA9A", boxShadow: "none" };
}

function getShellStatusDotClassName(shell: ShellSessionSummary): string {
  return getShellVisualStatus(shell) === "running"
    ? "terminal-session-status-dot terminal-session-status-dot--running"
    : "terminal-session-status-dot";
}

function CollapsedSessionsRail({
  shells,
  selectedShellName,
  terminalDividerColor,
  onExpand,
  creatingShell,
  newSessionMenuOpen,
  onNew,
  onNewMenuClose,
  onCreateShell,
  onCreateAgent,
  agentStatuses,
  onOpen,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  terminalDividerColor: string;
  onExpand: () => void;
  creatingShell: boolean;
  newSessionMenuOpen: boolean;
  onNew: () => void;
  onNewMenuClose: () => void;
  onCreateShell: () => void;
  onCreateAgent: (option: TerminalAgentOption, installed: boolean) => void;
  agentStatuses: Record<TerminalAgentId, boolean> | null;
  onOpen: (shell: ShellSessionSummary) => void;
}) {
  const activeShells = shells.filter((shell) => shell.placement !== "background");
  const backgroundShells = shells.filter((shell) => shell.placement === "background");
  return (
    <aside
      data-testid="terminal-collapsed-rail"
      className="shrink-0"
      style={{
        alignItems: "center",
        background: "var(--terminal-drawer-bg)",
        borderRight: `1px solid ${terminalDividerColor}`,
        color: "var(--terminal-drawer-fg)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 0",
        width: 76,
      }}
    >
      <div
        data-testid="terminal-collapsed-brand"
        className="flex items-center justify-center"
        style={{
          background: "var(--terminal-drawer-brand-bg)",
          borderRadius: 11,
          flexShrink: 0,
          height: COLLAPSED_RAIL_ITEM_SIZE,
          width: COLLAPSED_RAIL_ITEM_SIZE,
        }}
        title="matrix os"
      >
        <span
          aria-hidden="true"
          data-testid="terminal-collapsed-brand-mask"
          style={{
            background: "var(--terminal-drawer-brand-fg)",
            WebkitMaskImage: "url('/matrix-logo.svg')",
            maskImage: "url('/matrix-logo.svg')",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            display: "block",
            height: 22,
            width: 22,
          }}
        />
      </div>
      <CollapsedRailButton label="Expand sessions drawer" onClick={onExpand}>
        <ChevronsRightIcon data-testid="terminal-drawer-expand-icon" size={17} strokeWidth={2} />
      </CollapsedRailButton>
      <div style={{ position: "relative" }}>
        <CollapsedRailButton label="New session" onClick={onNew} strong disabled={creatingShell} expanded={newSessionMenuOpen}>
          <PlusIcon aria-hidden="true" data-testid="terminal-collapsed-new-session-icon" size={18} strokeWidth={2.5} />
        </CollapsedRailButton>
        {newSessionMenuOpen ? (
          <NewSessionMenu
            align="left"
            onClose={onNewMenuClose}
            onCreateShell={onCreateShell}
            onCreateAgent={onCreateAgent}
            agentStatuses={agentStatuses}
          />
        ) : null}
      </div>
      <div style={{ background: "var(--terminal-drawer-border)", height: 1, width: 34 }} />
      <CollapsedRailGroup shells={activeShells} selectedShellName={selectedShellName} onOpen={onOpen} />
      {backgroundShells.length > 0 && (
        <>
          <div
            data-testid="terminal-collapsed-background-divider"
            style={{
              background: "var(--terminal-drawer-border)",
              height: 1,
              marginTop: 2,
              width: 36,
            }}
          />
          <CollapsedRailGroup shells={backgroundShells} selectedShellName={selectedShellName} onOpen={onOpen} muted />
        </>
      )}
    </aside>
  );
}

function CollapsedRailGroup({
  shells,
  selectedShellName,
  onOpen,
  muted = false,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-center" style={{ gap: 9 }}>
      {shells.map((shell) => {
        const displayName = formatShellDisplayName(shell.name);
        const label = formatCollapsedShellLabel(shell.name);
        const selected = shell.name === selectedShellName;
        const accent = sessionAccent(shell.name);
        return (
          <button
            key={shell.name}
            type="button"
            aria-label={`Open ${displayName}`}
            aria-current={selected ? "true" : undefined}
            data-selected={selected ? "true" : "false"}
            title={displayName}
            onClick={() => onOpen(shell)}
            className="relative flex items-center justify-center"
            style={{
              background: accent.bg,
              border: `1px solid ${selected ? "var(--terminal-drawer-selected-border)" : accent.border}`,
              borderRadius: 11,
              boxShadow: selected ? "0 0 0 5px var(--terminal-drawer-selected-ring), 0 8px 18px var(--terminal-drawer-card-shadow)" : "none",
              color: accent.fg,
              cursor: "pointer",
              flexShrink: 0,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              fontWeight: 700,
              height: COLLAPSED_RAIL_ITEM_SIZE,
              lineHeight: "14px",
              opacity: muted ? 0.72 : 1,
              overflow: "visible",
              width: COLLAPSED_RAIL_ITEM_SIZE,
            }}
          >
            {label}
            <span
              aria-hidden="true"
              className={getShellStatusDotClassName(shell)}
              data-testid={`terminal-session-status-${shell.name}`}
              style={{
                ...getShellStatusDotStyle(shell),
                borderColor: "var(--terminal-drawer-bg)",
                borderStyle: "solid",
                borderWidth: 2,
                borderRadius: 999,
                boxSizing: "border-box",
                height: 12,
                position: "absolute",
                right: -3,
                top: -3,
                width: 12,
                zIndex: 1,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function CollapsedRailButton({
  label,
  onClick,
  children,
  strong = false,
  disabled = false,
  expanded = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  strong?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={label === "New session" ? "menu" : undefined}
      aria-expanded={label === "New session" ? expanded : undefined}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center"
      style={{
        background: strong ? "var(--terminal-drawer-primary-button-bg)" : "var(--terminal-drawer-button-bg)",
        border: strong ? "1px solid var(--terminal-drawer-primary-button-bg)" : "1px solid var(--terminal-drawer-button-border)",
        borderRadius: strong ? 11 : 10,
        color: strong ? "var(--terminal-drawer-primary-button-fg)" : "var(--terminal-drawer-button-fg)",
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
        fontSize: strong ? 24 : 14,
        fontWeight: 700,
        height: COLLAPSED_RAIL_ITEM_SIZE,
        lineHeight: 1,
        opacity: disabled ? 0.72 : 1,
        width: COLLAPSED_RAIL_ITEM_SIZE,
      }}
    >
      {children}
    </button>
  );
}

function ShellSessionGroup({
  label,
  shells,
  pending = false,
  expanded = true,
  onToggleExpanded,
  deletingShellNames,
  foreground,
  selectedShellName,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  draggingShellName,
  dragOverShellName,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: "Active" | "Background";
  shells: ShellSessionSummary[];
  pending?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  deletingShellNames: string[];
  foreground: boolean;
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  onToggle: (shell: ShellSessionSummary) => void;
  onRename: (shell: ShellSessionSummary, nextName: string) => Promise<boolean>;
  onDelete: (shell: ShellSessionSummary) => void;
  draggingShellName: string | null;
  dragOverShellName: string | null;
  onDragStart: (shell: ShellSessionSummary) => void;
  onDragOver: (shell: ShellSessionSummary) => void;
  onDrop: (shell: ShellSessionSummary) => void;
  onDragEnd: () => void;
}) {
  const collapsible = label === "Background";
  const contentId = `terminal-session-group-${label.toLowerCase()}-content`;
  return (
    <section data-testid={`terminal-session-group-${label.toLowerCase()}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="flex items-center justify-between" style={{ color: "var(--terminal-drawer-muted)", minHeight: 22 }}>
        <button
          type="button"
          aria-label={collapsible ? "Toggle Background sessions" : undefined}
          aria-expanded={collapsible ? expanded : undefined}
          aria-controls={collapsible ? contentId : undefined}
          disabled={!collapsible}
          onClick={collapsible ? onToggleExpanded : undefined}
          className="flex items-center"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--terminal-drawer-muted)",
            cursor: collapsible ? "pointer" : "default",
            gap: 7,
            padding: 0,
            textAlign: "left",
          }}
        >
          {collapsible && (
            <ChevronRightIcon
              aria-hidden="true"
              data-testid="terminal-session-background-chevron"
              size={12}
              strokeWidth={2.5}
              style={{
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
              }}
            />
          )}
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", lineHeight: "14px", textTransform: "uppercase" }}>
            {label}{" "}
            <span style={{ fontWeight: 600, opacity: 0.55 }}>({shells.length})</span>
          </span>
        </button>
      </div>
      <div
        id={contentId}
        hidden={!expanded}
        style={{ display: expanded ? "flex" : "none", flexDirection: "column", gap: 10 }}
      >
        {expanded ? (
          <>
          {pending ? <ShellPendingCard /> : null}
          {shells.length === 0 && !pending ? (
            <div style={{ color: "var(--terminal-drawer-subtle)", fontSize: 12, padding: "8px 0 6px" }}>
              {foreground ? "No active sessions" : "Nothing running in background"}
            </div>
          ) : shells.map((shell) => (
            <ShellCard
              key={`${label}-${shell.name}`}
              shell={shell}
              foreground={foreground}
              deleting={deletingShellNames.includes(shell.name)}
              selected={shell.name === selectedShellName}
              onOpen={() => onOpen(shell)}
              onToggle={() => onToggle(shell)}
              onRename={(nextName) => onRename(shell, nextName)}
              onDelete={() => onDelete(shell)}
              dragging={shell.name === draggingShellName}
              dropTarget={shell.name === dragOverShellName}
              onDragStart={() => onDragStart(shell)}
              onDragOver={() => onDragOver(shell)}
              onDrop={() => onDrop(shell)}
              onDragEnd={onDragEnd}
            />
          ))}
          </>
        ) : null}
      </div>
    </section>
  );
}

function ShellPendingCard() {
  return (
    <output
      aria-label="Creating shell session"
      data-testid="terminal-session-pending-row"
      style={{
        alignItems: "center",
        background: "var(--terminal-drawer-card-bg)",
        border: "1px solid var(--terminal-drawer-card-border)",
        borderRadius: 10,
        boxShadow: "0 9px 22px var(--terminal-drawer-card-shadow)",
        color: "var(--terminal-drawer-muted)",
        display: "grid",
        gap: 10,
        gridTemplateColumns: "12px 8px minmax(0, 1fr) 58px 46px",
        height: 52,
        opacity: 0.82,
        padding: "0 12px",
      }}
    >
      <span style={{ width: 12 }} />
      <span
        aria-hidden="true"
        className="terminal-refresh-icon--loading"
        style={{
          border: "2px solid var(--terminal-drawer-card-border)",
          borderTopColor: "var(--terminal-drawer-selected-stripe)",
          borderRadius: "50%",
          height: 8,
          width: 8,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 14,
          fontWeight: 700,
          lineHeight: "18px",
          minWidth: 0,
        }}
      >
        Creating session
      </span>
      <span />
      <span
        style={{
          background: "var(--terminal-drawer-action-bg)",
          border: "1px solid var(--terminal-drawer-action-border)",
          borderRadius: 999,
          color: "var(--terminal-drawer-action-fg)",
          fontSize: 12,
          fontWeight: 800,
          lineHeight: "18px",
          textAlign: "center",
        }}
      >
        NEW
      </span>
    </output>
  );
}

function ShellCard({
  shell,
  foreground,
  deleting,
  selected,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  shell: ShellSessionSummary;
  foreground: boolean;
  deleting?: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRename: (nextName: string) => Promise<boolean>;
  onDelete: () => void;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const statusDotStyle = getShellStatusDotStyle(shell);
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "failed" | null>(null);
  const displayName = formatShellDisplayName(shell.name);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(shell.name);
  const [renameSaving, setRenameSaving] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittingRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const restoreFocusAfterMenuCloseRef = useRef(false);
  const showActions = actionsVisible || copyFeedback !== null || contextMenuOpen;
  const showRenameControl = actionsVisible && !renaming;
  const showDragHandle = (actionsVisible || dragging) && !renaming && !deleting;
  const renameControlLabel = `Rename ${displayName}`;
  const toggleMenuLabel = foreground ? "Move to Background" : "Make Active";

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- menu close reason is intentionally held in a mutable ref so Escape/menu-item closes restore focus while outside-pointer closes do not; making it render state would add an extra close render and stale-focus edge cases
  useEffect(() => {
    if (!contextMenuOpen) return;
    const getMenuItems = () => Array.from(
      contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const focusMenuItem = (nextIndex: number) => {
      const items = getMenuItems();
      if (items.length === 0) return;
      const normalizedIndex = (nextIndex + items.length) % items.length;
      items[normalizedIndex]?.focus();
    };
    const firstMenuItem = getMenuItems()[0];
    firstMenuItem?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restoreFocusAfterMenuCloseRef.current = true;
        setContextMenuOpen(false);
        return;
      }
      const target = event.target;
      if (!(target instanceof Node) || !contextMenuRef.current?.contains(target)) return;
      const items = getMenuItems();
      if (items.length === 0) return;
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusMenuItem(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusMenuItem(items.length - 1);
      }
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      restoreFocusAfterMenuCloseRef.current = false;
      setContextMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (restoreFocusAfterMenuCloseRef.current) {
        moreButtonRef.current?.focus();
        restoreFocusAfterMenuCloseRef.current = false;
      }
    };
  }, [contextMenuOpen]);

  const closeContextMenuWithFocusReturn = () => {
    restoreFocusAfterMenuCloseRef.current = true;
    setContextMenuOpen(false);
  };

  const copyAttachCommand = async () => {
    try {
      await copyTextToClipboard(shellAttachCommand(shell));
      setCopyFeedback("copied");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1200);
    } catch (err: unknown) {
      console.warn("Failed to copy shell connect command:", err instanceof Error ? err.message : err);
      setCopyFeedback("failed");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1600);
    }
  };
  const cancelRename = useCallback(() => {
    setRenameDraft(shell.name);
    setRenaming(false);
  }, [shell.name]);

  const commitRename = useCallback(async (draft = renameDraft) => {
    const nextName = draft.trim();
    if (!nextName) {
      cancelRename();
      return;
    }
    if (renameSaving || renameCommittingRef.current) return;
    if (nextName === shell.name) {
      setRenaming(false);
      return;
    }
    renameCommittingRef.current = true;
    setRenameSaving(true);
    let renamed = false;
    try {
      renamed = await onRename(nextName);
    } catch (err: unknown) {
      console.warn("Failed to commit shell session rename:", err instanceof Error ? err.message : err);
    }
    if (renamed) {
      setRenaming(false);
    }
    renameCommittingRef.current = false;
    setRenameSaving(false);
  }, [cancelRename, onRename, renameDraft, renameSaving, shell.name]);

  const finishRename = useCallback(() => {
    if (renameCommittingRef.current) return;
    const nextDraft = renameInputRef.current?.value ?? renameDraft;
    if (nextDraft.trim() === shell.name || nextDraft.trim().length === 0) {
      cancelRename();
      return;
    }
    void commitRename(nextDraft);
  }, [cancelRename, commitRename, renameDraft, shell.name]);

  useEffect(() => {
    if (!renaming) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) {
        return;
      }
      finishRename();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [finishRename, renaming]);

  const handleCardClick = () => {
    if (renaming || renameSaving || deleting) return;
    onOpen();
  };

  return (
    <div
      ref={cardRef}
      className="group terminal-session-card"
      data-testid={`terminal-session-card-${shell.name}`}
      onDragOver={(event) => {
        if (!dragging) {
          event.preventDefault();
        }
        event.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseMove={() => setActionsVisible(true)}
      onMouseOver={() => setActionsVisible(true)}
      onMouseLeave={() => setActionsVisible(false)}
      onPointerEnter={() => setActionsVisible(true)}
      onPointerMove={() => setActionsVisible(true)}
      onPointerOver={() => setActionsVisible(true)}
      onPointerLeave={() => setActionsVisible(false)}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setActionsVisible(false);
        }
      }}
      style={{
        background: selected ? "var(--terminal-drawer-card-bg)" : foreground ? "var(--terminal-drawer-card-bg)" : "var(--terminal-drawer-card-muted-bg)",
        border: `1px solid ${selected ? "var(--terminal-drawer-selected-border)" : foreground ? "var(--terminal-drawer-card-border)" : "var(--terminal-drawer-card-muted-border)"}`,
        borderRadius: 10,
        boxShadow: dragging
          ? "0 18px 34px var(--terminal-drawer-card-shadow)"
          : selected
            ? "0 0 0 5px var(--terminal-drawer-selected-ring), 0 14px 30px var(--terminal-drawer-card-shadow)"
            : foreground ? "0 9px 22px var(--terminal-drawer-card-shadow)" : "none",
        cursor: renaming || deleting ? "default" : "pointer",
        alignItems: "center",
        display: "grid",
        gap: 10,
        // Single full-width column: the hover action icons overlay the right
        // edge (absolute, anchored to the inner grid row) and the inner row's
        // paddingRight reserves their space, so no dead reserved column is
        // needed here — that column only pushed the actions ~46px off the edge.
        gridTemplateColumns: "minmax(0, 1fr)",
        height: 52,
        opacity: dragging ? 0.94 : foreground ? 1 : 0.86,
        padding: "0 12px",
        position: "relative",
        transform: dragging ? "translateY(-2px)" : "translateY(0)",
        transition: "border-color 150ms ease, box-shadow 150ms ease, opacity 120ms ease, transform 150ms ease",
      }}
    >
      {dropTarget && (
        <span
          aria-hidden="true"
          data-testid={`terminal-session-drop-line-${shell.name}`}
          style={{
            background: "var(--terminal-drawer-drop-line)",
            borderRadius: 999,
            height: 3,
            left: 12,
            position: "absolute",
            right: 12,
            top: -7,
            zIndex: 3,
          }}
        />
      )}
      {selected && (
        <span
          aria-hidden="true"
          style={{
            background: "var(--terminal-drawer-selected-stripe)",
            borderRadius: 999,
            bottom: 12,
            left: -1,
            position: "absolute",
            top: 12,
            width: 3,
            zIndex: 2,
          }}
        />
      )}
      {!renaming && !deleting && (
        <button
          type="button"
          data-testid={`terminal-session-row-${shell.name}`}
          aria-current={selected ? "true" : undefined}
          aria-label={`Show ${displayName} session`}
          data-selected={selected ? "true" : "false"}
          onClick={handleCardClick}
          style={SHELL_ROW_BUTTON_STYLE}
        />
      )}
      <div
        className="min-w-0"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 10,
          gridTemplateColumns: "12px 8px minmax(0, 1fr)",
          pointerEvents: "none",
          position: "relative",
          zIndex: 1,
        }}
      >
        <button
          type="button"
          aria-label={`Drag ${displayName} session`}
          draggable={!renaming && !deleting}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", shell.name);
            onDragStart();
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            onDragEnd();
          }}
          className="flex items-center justify-center"
          style={{
            ...SHELL_ROW_DRAG_HANDLE_STYLE,
            cursor: showDragHandle ? "grab" : "default",
            opacity: showDragHandle ? 1 : 0,
          }}
        >
          <GripVerticalIcon size={12} strokeWidth={2.1} />
        </button>
        <span
          className={getShellStatusDotClassName(shell)}
          data-testid={`terminal-session-status-${shell.name}`}
          style={{
            width: foreground ? 7 : 8,
            height: foreground ? 7 : 8,
            borderRadius: "50%",
            flexShrink: 0,
            ...statusDotStyle,
          }}
          />
        <div
          className="min-w-0"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 6,
          gridTemplateColumns: "minmax(0, 1fr)",
          paddingRight: renaming ? 0 : 58,
        }}
      >
          {renaming ? (
            <input
              ref={renameInputRef}
              aria-label={`Session name for ${displayName}`}
              value={renameDraft}
              disabled={renameSaving}
              onChange={(event) => setRenameDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onBlur={finishRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              style={SESSION_RENAME_INPUT_STYLE}
            />
          ) : (
            <button
              type="button"
              data-session-name={shell.name}
              data-testid={`terminal-session-name-${shell.name}`}
              aria-label={`Open ${displayName}`}
              className="min-w-0 truncate"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              style={{
                ...SESSION_NAME_BUTTON_BASE_STYLE,
                color: foreground ? "var(--terminal-drawer-fg)" : "var(--terminal-drawer-muted)",
              }}
            >
              {displayName}
            </button>
          )}
          {!renaming && (
            <div
              data-testid={`terminal-session-actions-${shell.name}`}
              aria-hidden={showActions ? undefined : "true"}
              className="flex shrink-0 items-center justify-end"
              style={{
                ...SESSION_ACTIONS_STYLE,
                opacity: showActions ? 1 : 0,
                pointerEvents: showActions ? "auto" : "none",
              }}
            >
              <button
                type="button"
                aria-label={renameControlLabel}
                title={renameControlLabel}
                disabled={renameSaving}
                tabIndex={showActions ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation();
                  setRenameDraft(shell.name);
                  setRenaming(true);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                className="flex items-center justify-center"
                style={{
                  ...SESSION_RENAME_BUTTON_STYLE,
                  cursor: renameSaving ? "not-allowed" : "pointer",
                  opacity: showRenameControl ? 1 : 0,
                }}
              >
                <PencilIcon size={12} strokeWidth={2} />
              </button>
              <div style={{ position: "relative" }}>
                <button
                  ref={moreButtonRef}
                  type="button"
                  aria-label={`More actions for ${displayName}`}
                  aria-haspopup="menu"
                  aria-expanded={contextMenuOpen}
                  tabIndex={showActions ? 0 : -1}
                  onClick={(event) => {
                    event.stopPropagation();
                    restoreFocusAfterMenuCloseRef.current = true;
                    setContextMenuOpen((open) => !open);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  className="flex items-center justify-center"
                  style={{
                    ...SESSION_MORE_BUTTON_STYLE,
                    opacity: showActions ? 1 : 0,
                  }}
                >
                  <MoreHorizontalIcon size={14} strokeWidth={2.2} />
                </button>
                {contextMenuOpen ? (
                  <div
                    ref={contextMenuRef}
                    role="menu"
                    aria-label={`Actions for ${displayName}`}
                    tabIndex={-1}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    style={SESSION_CONTEXT_MENU_STYLE}
                  >
                    <SessionContextMenuItem
                      label={toggleMenuLabel}
                      onClick={() => {
                        closeContextMenuWithFocusReturn();
                        onToggle();
                      }}
                    >
                      <Rows2Icon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                    <SessionContextMenuItem
                      label="Copy Command"
                      onClick={() => {
                        void copyAttachCommand();
                        closeContextMenuWithFocusReturn();
                      }}
                    >
                      <LinkIcon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                    <SessionContextMenuItem
                      label={deleting ? "Deleting" : "Close"}
                      disabled={deleting}
                      onClick={() => {
                        if (deleting) return;
                        closeContextMenuWithFocusReturn();
                        onDelete();
                      }}
                    >
                      <Trash2Icon size={13} strokeWidth={2} />
                    </SessionContextMenuItem>
                  </div>
                ) : null}
              </div>
              {copyFeedback ? (
                <output
                  data-testid={`terminal-session-copy-toast-${shell.name}`}
                  aria-live="polite"
                  style={{
                    ...SESSION_COPY_FEEDBACK_STYLE,
                    color: copyFeedback === "copied"
                      ? "var(--terminal-drawer-selected-stripe)"
                      : "var(--terminal-drawer-danger-fg)",
                  }}
                >
                  {copyFeedback === "copied" ? (
                    <CheckIcon aria-hidden="true" size={12} strokeWidth={2.4} />
                  ) : (
                    <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 900 }}>!</span>
                  )}
                  <span>{copyFeedback === "copied" ? "Copied" : "Copy failed"}</span>
                </output>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionContextMenuItem({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        ...SESSION_CONTEXT_MENU_ITEM_STYLE,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.62 : 1,
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = "var(--terminal-drawer-action-bg)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--terminal-drawer-action-fg)", display: "flex", flexShrink: 0 }}>
        {children}
      </span>
      <span>{label}</span>
    </button>
  );
}

function SessionCard({
  session,
  onObserve,
  onTakeover,
  onDuplicate,
  onKill,
}: {
  session: WorkspaceSessionSummary;
  onObserve: () => void;
  onTakeover: () => void;
  onDuplicate: () => void;
  onKill: () => void;
}) {
  const health = session.runtime?.status ?? session.status ?? "unknown";
  return (
    <div
      style={{
        margin: "3px 8px",
        padding: "8px 10px 6px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--background)",
      }}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: health === "running" ? "var(--success)" : "var(--muted-foreground)",
            flexShrink: 0,
          }}
        />
        <span className="text-[12px] truncate flex-1" style={{ color: "var(--foreground)", fontWeight: 500 }}>
          {session.id}
        </span>
      </div>
      <div className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {health} health
      </div>
      <div className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {[session.projectSlug, session.taskId, session.agent ?? session.kind ?? "shell"].filter(Boolean).join(" · ")}
      </div>
      {session.nativeAttachCommand && (
        <div
          className="text-[10px] truncate"
          style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono, ui-monospace, monospace)", paddingLeft: 12, marginTop: 4 }}
        >
          {session.nativeAttachCommand.join(" ")}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1" style={{ marginTop: 6, paddingLeft: 12 }}>
        <SessionActionBtn label="Observe" sessionId={session.id} onClick={onObserve} />
        <SessionActionBtn label="Take over" sessionId={session.id} onClick={onTakeover} />
        <SessionActionBtn label="Duplicate" sessionId={session.id} onClick={onDuplicate} />
        <SessionActionBtn label="Kill" sessionId={session.id} onClick={onKill} danger />
      </div>
    </div>
  );
}

function SessionActionBtn({
  label,
  sessionId,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  sessionId: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} ${sessionId}`}
      onClick={onClick}
      disabled={disabled}
      className="text-[10px] cursor-pointer transition-colors"
      style={{
        padding: "2px 6px",
        borderRadius: 3,
        background: danger ? "var(--destructive)" : "var(--card)",
        color: danger ? "white" : "var(--foreground)",
        border: danger ? "none" : "1px solid var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {label}
    </button>
  );
}

interface ProjectCardProps {
  project: ProjectInfo;
  onOpenShell: () => void;
  onOpenClaude: () => void;
  onOpenZellij: () => void;
  onSelect: () => void;
  isSelected: boolean;
}

function ProjectCard({ project, onOpenShell, onOpenClaude, onOpenZellij, onSelect, isSelected }: ProjectCardProps) {
  const [hover, setHover] = useState(false);
  return (
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- cannot be a native <button>: this selectable card contains nested interactive <button> children (shell and agent actions), and nesting a button inside a button is invalid HTML; role="button" + tabIndex + keyboard handler is the correct accessible pattern here.
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`Select project ${project.name}`}
      className="cursor-pointer transition-colors"
      style={{
        margin: "3px 8px",
        padding: "8px 10px 6px",
        borderRadius: 6,
        background: isSelected ? "var(--accent)" : hover ? "var(--accent)" : "transparent",
        border: `1px solid ${isSelected ? "var(--primary)" : "transparent"}`,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      onDoubleClick={onOpenShell}
      title={`${project.path}\nDouble-click to open terminal`}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: project.dirtyCount > 0 ? "var(--warning)" : project.isGit ? "var(--success)" : "var(--muted-foreground)",
            flexShrink: 0,
          }}
        />
        <span
          className="text-[12px] truncate flex-1"
          style={{ color: "var(--foreground)", fontWeight: 500 }}
        >
          {project.name}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {project.isGit && project.branch && (
          <span style={PROJECT_BRANCH_BADGE_STYLE}>
            {project.branch}
          </span>
        )}
        {project.dirtyCount > 0 && (
          <span
            style={{
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--warning)",
              color: "var(--card)",
              fontWeight: 600,
            }}
          >
            {project.dirtyCount}
          </span>
        )}
        {!project.isGit && <span style={{ opacity: 0.6 }}>folder</span>}
      </div>
      <div
        className="flex items-center gap-1"
        style={{
          marginTop: 6,
          paddingLeft: 12,
          opacity: hover || isSelected ? 1 : 0,
          maxHeight: hover || isSelected ? 22 : 0,
          overflow: "hidden",
          // react-doctor-disable-next-line react-doctor/no-layout-transition-inline -- intentional max-height collapse so the hover action row reclaims its vertical space when not active and the project list stays compact; transform/opacity cannot reclaim layout space, and the transition is a short bounded 120ms micro-reveal
          transition: "opacity 120ms, max-height 120ms",
        }}
      >
        <ProjectActionBtn label="Shell" onClick={(e) => { e.stopPropagation(); onOpenShell(); }} />
        <ProjectActionBtn label="Claude" onClick={(e) => { e.stopPropagation(); onOpenClaude(); }} accent="var(--success)" />
        <ProjectActionBtn label="Session" onClick={(e) => { e.stopPropagation(); onOpenZellij(); }} accent="var(--primary)" />
      </div>
    </div>
  );
}

function ProjectActionBtn({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] cursor-pointer transition-colors"
      style={{
        padding: "2px 6px",
        borderRadius: 3,
        background: accent ?? "var(--background)",
        color: accent ? "white" : "var(--foreground)",
        border: accent ? "none" : "1px solid var(--border)",
        opacity: 0.9,
      }}
    >
      {label}
    </button>
  );
}

// ---- Tree helpers ----

interface TreeNode { name: string; type: "file" | "directory"; size?: number; gitStatus: string | null; changedCount?: number; path: string; children?: TreeNode[]; expanded?: boolean; }

const GIT_COLORS: Record<string, string> = { modified: "var(--warning)", added: "var(--success)", untracked: "var(--success)", deleted: "var(--destructive)", renamed: "var(--primary)" };

function filterTreeNodes(nodes: TreeNode[], normalizedFilter: string): TreeNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? filterTreeNodes(node.children, normalizedFilter) : [];
    const matches = [
      node.name,
      node.path,
      node.gitStatus,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter);

    if (matches) {
      return [{ ...node, expanded: node.type === "directory" ? true : node.expanded }];
    }
    if (children.length > 0) {
      return [{ ...node, children, expanded: true }];
    }
    return [];
  });
}

function TreeItem({ node, depth, selectedPath, onToggle, onSelect, onOpenTerminal }: { node: TreeNode; depth: number; selectedPath: string | null; onToggle: (n: TreeNode) => void; onSelect: (n: TreeNode) => void; onOpenTerminal: (path: string) => void }) {
  const rowStyle = {
    paddingLeft: 8 + depth * 12,
    background: selectedPath === node.path ? "var(--accent)" : undefined,
    color: (node.gitStatus && GIT_COLORS[node.gitStatus]) ?? "var(--foreground)",
  };
  const rowContent = (
    <>
      {node.type === "directory" ? <span className="text-[10px] opacity-60" style={{ width: 10 }}>{node.expanded ? "▾" : "▸"}</span> : <span style={{ width: 10 }} />}
      <span className="truncate flex-1">{node.name}</span>
      {node.type === "directory" && (node.changedCount ?? 0) > 0 && <span className="text-[9px] px-1 rounded" style={{ background: "var(--warning)", color: "var(--card)", opacity: 0.8 }}>{node.changedCount}</span>}
    </>
  );

  if (node.type !== "directory") {
    return (
      <div
        aria-label={node.name}
        className="w-full text-left flex items-center gap-1 px-2 py-0.5"
        style={rowStyle}
      >
        {rowContent}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label={node.name}
        className="w-full text-left flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-[var(--accent)] transition-colors"
        style={rowStyle}
        onClick={() => { if (node.type === "directory") { onToggle(node); onSelect(node); } }}
        onDoubleClick={() => { if (node.type === "directory") onOpenTerminal(node.path); }}
      >
        {rowContent}
      </button>
      {node.expanded && node.children?.map(c => <TreeItem key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} onOpenTerminal={onOpenTerminal} />)}
    </>
  );
}

function updateNode(nodes: TreeNode[], path: string, update: Partial<TreeNode>): TreeNode[] {
  return nodes.map(n => {
    if (n.path === path) return { ...n, ...update };
    if (n.children) return { ...n, children: updateNode(n.children, path, update) };
    return n;
  });
}
