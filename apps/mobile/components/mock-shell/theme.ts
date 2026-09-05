import { fonts, palette, semanticColors } from "@/lib/theme";

// Compatibility bridge for the first authenticated mock screens. New UI should
// consume the semantic Unistyles theme directly through components/ui.
export const mockColors = {
  canvas: semanticColors.background,
  surface: semanticColors.card,
  ink: semanticColors.textDefault,
  muted: semanticColors.textSubtle,
  line: semanticColors.borderSubtle,
  soft: semanticColors.accentSurface,
  blue: semanticColors.info,
  blueSoft: palette.blue[50],
  green: semanticColors.success,
  danger: semanticColors.danger,
  disabledSurface: semanticColors.disabledSurface,
  warmSurface: palette.gold[100],
  terminal: "#161817",
  terminalInk: "#D9F7DE",
} as const;

export const mockFonts = {
  display: fonts.productSemiBold,
  body: fonts.product,
  medium: fonts.productMedium,
  semibold: fonts.productSemiBold,
  mono: fonts.mono,
} as const;
