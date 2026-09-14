// The design token source for the app: palette/semanticColors/fonts/spacing/
// radius/typography, in both a light and an on-brand dark variant.
//
// These are plain data exports (no hook). Runtime reactivity to the user's
// theme preference is wired through lib/unistyles.ts's `v2` theme group —
// components read `theme.v2.colors`/`theme.v2.appColors` via
// `StyleSheet.create((theme) => ...)` or `useUnistyles()`.

export const palette = {
  green: {
    900: "#171F0A", 800: "#2B3715", 700: "#475926", 600: "#62783A",
    500: "#748E59", 400: "#9AC059", 300: "#BED77B", 200: "#CEE0AE",
    100: "#E4EDD4", 50: "#F4F7ED", 25: "#F9FBF5",
  },
  coral: {
    900: "#25130E", 800: "#442118", 700: "#6B3324", 600: "#8F432D",
    500: "#BA5236", 400: "#D06E53", 300: "#DA9481", 200: "#E6B5A8",
    100: "#F2D6CF", 50: "#FAEEEB", 25: "#FDF7F5",
  },
  teal: {
    900: "#061810", 800: "#0E3422", 700: "#13492F", 600: "#1B6541",
    500: "#288A5B", 400: "#34B275", 300: "#5EC996", 200: "#97D8B9",
    100: "#C9E8D9", 50: "#EEF7F2", 25: "#F7FBF9",
  },
  gold: {
    900: "#251C0E", 800: "#4D3919", 700: "#775622", 600: "#A37429",
    500: "#D2932D", 400: "#E0AA52", 300: "#F1C379", 200: "#F6DAAC",
    100: "#FAEAD1", 50: "#FCF5E8", 25: "#FEFAF3",
  },
  blue: {
    900: "#0F1B24", 800: "#193143", 700: "#254D6A", 600: "#306991",
    500: "#3B85BA", 400: "#5CA0D1", 300: "#71A9D0", 200: "#9DBFD7",
    100: "#C5D6E2", 50: "#EDF3F7", 25: "#F6F9FB",
  },
  neutral: {
    900: "#0D0C0C", 800: "#242323", 700: "#413E3E", 600: "#635F5F",
    500: "#827D7D", 400: "#A8A4A4", 300: "#C8C6C6", 200: "#E1E0E0",
    100: "#F3F2F2", 50: "#FFFFFF", 25: "#FFFFFF",
  },
} as const;

export const fonts = {
  mono: "JetBrainsMono_400Regular" as const,
  product: "Geist_400Regular" as const,
  productMedium: "Geist_500Medium" as const,
  productSemiBold: "Geist_600SemiBold" as const,
  productExtraBold: "Geist_800ExtraBold" as const,
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
  "4xl": 64,
} as const;

export type SpacingSize = keyof typeof spacing;

export const radius = {
  tag: 6,
  control: 10,
  card: 12,
  modal: 16,
  container: 20,
  full: 9999,
} as const;

export const typography = {
  h1: { fontFamily: fonts.productExtraBold, fontSize: 36, lineHeight: 40, letterSpacing: -1.08 },
  h2: { fontFamily: fonts.productSemiBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  h3: { fontFamily: fonts.productSemiBold, fontSize: 24, lineHeight: 32, letterSpacing: -0.24 },
  large: { fontFamily: fonts.productSemiBold, fontSize: 18, lineHeight: 28 },
  body: { fontFamily: fonts.product, fontSize: 16, lineHeight: 28 },
  muted: { fontFamily: fonts.product, fontSize: 14, lineHeight: 20 },
  overline: {
    fontFamily: fonts.productMedium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.88,
    textTransform: "uppercase" as const,
  },
} as const;

// Light semantics — conserved as-is from lib/theme.ts's `semanticColors`.
const semanticColorsLight = {
  background: palette.green[50],
  card: palette.neutral[100],
  accentSurface: palette.teal[50],
  borderSubtle: palette.neutral[300],
  textDefault: palette.neutral[800],
  textSubtle: palette.neutral[600],
  textInverse: palette.neutral[50],
  brand: palette.green[500],
  brandStrong: palette.green[700],
  action: palette.coral[500],
  success: palette.teal[500],
  highlight: palette.gold[400],
  info: palette.blue[500],
  danger: palette.coral[600],
  disabledSurface: palette.neutral[300],
} as const;

// Dark semantics — on-brand, built from the same palette families as light,
// shifted to the shades that read correctly against a dark ground: neutral
// scale reversed for surfaces/text, brand/status hues moved one step lighter
// so they stay legible (and keep the same 1-step action/danger gap as light).
const semanticColorsDark = {
  background: palette.neutral[900],
  card: palette.neutral[800],
  accentSurface: palette.teal[800],
  borderSubtle: palette.neutral[700],
  textDefault: palette.neutral[100],
  textSubtle: palette.neutral[400],
  textInverse: palette.neutral[50],
  brand: palette.green[400],
  brandStrong: palette.green[300],
  action: palette.coral[400],
  success: palette.teal[400],
  highlight: palette.gold[400],
  info: palette.blue[400],
  danger: palette.coral[500],
  disabledSurface: palette.neutral[700],
} as const;

export const semanticColorsByMode = {
  light: semanticColorsLight,
  dark: semanticColorsDark,
} as const;

export type ThemeMode = keyof typeof semanticColorsByMode;
export type SemanticColors = typeof semanticColorsLight;

// Flat light alias — most new-app files build StyleSheet.create() at module
// scope (outside any component), so they read a static palette today rather
// than reacting to theme mode. Keep that behavior; use `useAppTheme()` below
// wherever a screen needs to react to the active mode.
export const semanticColors = semanticColorsLight;

export const designShadows = {
  sm: "0 2px 4px rgba(51, 46, 36, 0.06)",
  md: "0 4px 8px rgba(51, 46, 36, 0.08)",
  lg: "0 8px 16px rgba(51, 46, 36, 0.10)",
  lgShine: "inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 16px rgba(51, 46, 36, 0.10)",
} as const;

// Flattened aliases, per mode, for the common surface/text roles screens
// reach for most often.
function buildAppColors(mode: ThemeMode) {
  const semantic = semanticColorsByMode[mode];
  const p = palette;
  return {
    canvas: semantic.background,
    surface: semantic.card,
    ink: semantic.textDefault,
    muted: semantic.textSubtle,
    line: semantic.borderSubtle,
    soft: semantic.accentSurface,
    blue: semantic.info,
    blueSoft: mode === "dark" ? p.blue[900] : p.blue[50],
    green: semantic.success,
    danger: semantic.danger,
    disabledSurface: semantic.disabledSurface,
    warmSurface: mode === "dark" ? p.gold[900] : p.gold[100],
    // The terminal is always a dark console regardless of the app's color
    // scheme, so these two stay constant across modes.
    terminal: "#161817",
    terminalInk: "#D9F7DE",
  } as const;
}

export const appColors = {
  light: buildAppColors("light"),
  dark: buildAppColors("dark"),
} as const;

export const appFonts = {
  display: fonts.productSemiBold,
  body: fonts.product,
  medium: fonts.productMedium,
  semibold: fonts.productSemiBold,
  mono: fonts.mono,
} as const;
