import type { Theme } from "@/hooks/useTheme";

/**
 * Per-OS-design terminal interior chrome. The active OS design comes from
 * `Theme.style` (mirrored to `document.documentElement.dataset.themeStyle`)
 * and is consumed through `useThemeStyle()`. Only the three OS designs get a
 * native terminal interior; flat/neumorphic keep the default Matrix terminal
 * chrome untouched.
 */
export type TerminalDesignId = "winxp" | "win11" | "macos-glass";

export function resolveTerminalDesign(style: string | null | undefined): TerminalDesignId | null {
  switch (style) {
    case "winxp":
      return "winxp";
    case "win11":
      return "win11";
    case "macos-glass":
      return "macos-glass";
    default:
      return null;
  }
}

/** cmd.exe (Campbell) console: black background, white/gray text. */
export const WINXP_TERMINAL_BACKGROUND = "#0C0C0C";
export const WINXP_TERMINAL_FOREGROUND = "#CCCCCC";
export const WINXP_TERMINAL_FONT_MONO = '"Lucida Console", monospace';

/** Terminal.app-style light translucent content background. */
export const MACOS_GLASS_TERMINAL_BACKGROUND = "rgba(245, 245, 247, 0.78)";

/**
 * Adjusts the shell theme tokens that flow into xterm (via `buildXtermTheme`
 * and `buildTerminalFontStack`) so the terminal content matches the active OS
 * design. These tokens are only consulted when the terminal theme setting is
 * "system" — an explicit terminal theme preset always wins. The xterm font
 * setting itself still leads the stack; the design font becomes the themed
 * mono fallback. Pure: returns a new theme object, never mutates the input.
 */
export function applyTerminalDesignTheme(theme: Theme, design: TerminalDesignId | null): Theme {
  switch (design) {
    case "winxp":
      return {
        ...theme,
        colors: {
          ...theme.colors,
          background: WINXP_TERMINAL_BACKGROUND,
          foreground: WINXP_TERMINAL_FOREGROUND,
        },
        fonts: {
          ...theme.fonts,
          mono: WINXP_TERMINAL_FONT_MONO,
        },
      };
    case "macos-glass":
      return {
        ...theme,
        colors: {
          ...theme.colors,
          background: MACOS_GLASS_TERMINAL_BACKGROUND,
        },
      };
    default:
      // win11 (and the default design) keep the existing terminal rendering.
      return theme;
  }
}
