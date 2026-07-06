import { StyleSheet } from "react-native-unistyles";
import { colors, fonts, glass, radius, shadows, spacing, type } from "@/lib/theme";

// Shared, theme-independent token groups. Typography, radii, spacing, fonts and
// the terminal console palette are identical across color schemes, so they are
// spread into every theme.
const shared = {
  fonts,
  radius,
  spacing,
  type,
  shadows,
  glass,
  // The terminal is always a dark console regardless of the shell color scheme.
  terminal: colors.terminal,
} as const;

// Botanical-light is the canonical Matrix OS mobile look. `colors.light` already
// carries the full token set the shell uses, so the light theme maps 1:1.
const lightTheme = {
  colors: colors.light,
  ...shared,
} as const;

// A complete dark counterpart. `colors.dark` only defines a base palette, so the
// botanical tokens (paper/panel/ink/line/field/…) are derived here from the dark
// base plus the brighter terminal accents so nothing renders as undefined if dark
// mode is enabled later.
const darkColors = {
  ...colors.dark,
  paper: colors.dark.background,
  panel: colors.dark.card,
  ink: colors.dark.foreground,
  inkMuted: colors.dark.mutedForeground,
  inkDim: colors.terminal.brightBlack,
  line: colors.dark.border,
  lineSoft: "rgba(154, 164, 140, 0.08)",
  field: colors.dark.secondary,
  borderStrong: "rgba(154, 164, 140, 0.22)",
  accentInk: colors.terminal.brightGreen,
  glow: colors.light.glow,
  add: colors.terminal.green,
  del: colors.terminal.red,
  console: colors.terminal.surface,
  statusWaiting: colors.light.statusWaiting,
  statusRunning: colors.light.statusRunning,
  statusIdle: colors.light.statusIdle,
  statusDone: colors.light.statusDone,
} as const;

const darkTheme = {
  colors: darkColors,
  ...shared,
} as const;

const appThemes = {
  light: lightTheme,
  dark: darkTheme,
} as const;

const breakpoints = {
  xs: 0,
  sm: 360,
  md: 600,
  lg: 768,
  xl: 1024,
} as const;

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module "react-native-unistyles" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

StyleSheet.configure({
  themes: appThemes,
  breakpoints,
  settings: {
    // The mobile shell is light-first today; keep it deterministic. Flip to
    // `adaptiveThemes: true` to follow the system color scheme.
    initialTheme: "light",
  },
});
