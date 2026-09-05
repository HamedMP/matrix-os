import { appColors, appFonts } from "@/lib/theme-v2";

// Compatibility bridge for the first authenticated mock screens. New UI should
// consume the semantic Unistyles theme directly through components/ui.
export const mockColors = {
  ...appColors.light,
  terminal: "#161817",
  terminalInk: "#D9F7DE",
} as const;

export const mockFonts = appFonts;
