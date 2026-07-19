/**
 * Maps the active theme style id (the `data-theme-style` attribute set on
 * document.documentElement by the theme system) to the window title-bar
 * variant rendered by shell windows.
 *
 * - "flat" (and any unknown/empty style) keeps the default mac floating bar
 * - "neumorphic" keeps the win98 raised bar
 * - "macos-glass" gets a frosted-glass floating bar with traffic lights
 * - "winxp" / "win11" get right-aligned caption buttons instead of traffic
 *   lights (Luna / Fluent chrome)
 */
import type { CSSProperties } from "react";

export type TitleBarVariant = "mac" | "win98" | "macos-glass" | "winxp" | "win11";

export function resolveTitleBarVariant(style: string | null | undefined): TitleBarVariant {
  switch (style) {
    case "neumorphic":
      return "win98";
    case "macos-glass":
      return "macos-glass";
    case "winxp":
      return "winxp";
    case "win11":
      return "win11";
    default:
      return "mac";
  }
}

/** XP and Win11 chrome use right-aligned caption buttons, not traffic lights. */
export function usesCaptionButtons(variant: TitleBarVariant): boolean {
  return variant === "winxp" || variant === "win11";
}

/**
 * Header chrome (background / border / shadow) for a window title-bar
 * container in the given design system. Returns undefined for the default
 * mac/win98 variants so existing headers render exactly as before.
 */
export function designTitleBarContainerStyle(
  variant: TitleBarVariant,
): CSSProperties | undefined {
  switch (variant) {
    case "macos-glass":
      return {
        background: "var(--glass-surface-strong)",
        backdropFilter: "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        borderBottom: "1px solid var(--glass-edge)",
        boxShadow: "var(--glass-specular)",
      };
    case "winxp":
      return {
        background: "var(--xp-titlebar)",
        borderBottom: "1px solid #003c9e",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.4)",
        color: "#ffffff",
      };
    case "win11":
      return {
        background: "var(--win11-acrylic-strong)",
        backdropFilter: "var(--win11-blur)",
        WebkitBackdropFilter: "var(--win11-blur)",
        borderBottom: "1px solid var(--win11-stroke)",
      };
    default:
      return undefined;
  }
}
