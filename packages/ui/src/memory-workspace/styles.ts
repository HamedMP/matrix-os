import {
  desktopPalette as colors,
  desktopFonts as fonts,
  palette,
} from "@matrix-os/brand/tokens";
import type { CSSProperties } from "react";
export const workspaceStyle = {
  "--mw-paper": colors.paper,
  "--mw-canvas": colors.surfaceMuted,
  "--mw-ink": palette.brandInk,
  "--mw-muted": colors.textMuted,
  "--mw-primary": colors.forest,
  "--mw-green": colors.green,
  "--mw-gold": colors.gold,
  "--mw-border": palette.cream,
  "--mw-danger": colors.danger,
  "--mw-blue": colors.blue,
  fontFamily: fonts.sans,
  color: palette.brandInk,
  backgroundColor: colors.paper,
} as CSSProperties;
export const headingStyle = { fontFamily: fonts.display };
export const mwButton = "mw-button";
