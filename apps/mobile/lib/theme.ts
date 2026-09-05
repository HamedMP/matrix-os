export const colors = {
  light: {
    background: "#FAFAF9",
    foreground: "#1c1917",
    card: "#FFFFFF",
    cardForeground: "#1c1917",
    primary: "#9AA48C",
    primaryForeground: "#141614",
    secondary: "#F2F5F3",
    secondaryForeground: "#1c1917",
    muted: "#F2F5F3",
    mutedForeground: "#6B7280",
    border: "#E5E5E4",
    ring: "#D06F25",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    forest: "#323D2E",
    moss: "#6A8A7A",
    lichen: "#9AA48C",
    // Botanical-light design system (Paper-synced 2026-06-24)
    paper: "#FAFAF9",
    panel: "#FFFFFF",
    ink: "#1A1D18",
    inkMuted: "#6B756B",
    inkDim: "#9AA098",
    line: "#E7E9E3",
    lineSoft: "#EFF1EC",
    field: "#F1F3EE",
    borderStrong: "#D2D7CE",
    accentInk: "#4E6A4A",
    glow: "#D06F25",
    add: "#3F7D4E",
    del: "#C2603A",
    console: "#F4F6F1",
    // Semantic session status
    statusWaiting: "#D06F25",
    statusRunning: "#9AA48C",
    statusIdle: "#9AA098",
    statusDone: "#6A8A7A",
  },
  // Dark console — a botanical-tinted near-black so the terminal reads as a
  // proper terminal window against the light shell chrome. The greens/cyans are
  // pushed brighter than the shell palette so prompts and diffs pop on dark ink.
  terminal: {
    bg: "#121511",
    surface: "#171B14",
    fg: "#E4E8DE",
    fgDim: "#9BA593",
    cursor: "#B7C3A6",
    selection: "rgba(154, 164, 140, 0.30)",
    border: "rgba(228, 232, 222, 0.08)",
    black: "#2A2E26",
    red: "#E06A4E",
    green: "#7FC58D",
    yellow: "#D9B45A",
    blue: "#83A8DB",
    magenta: "#C29BD4",
    cyan: "#6FCFC4",
    white: "#C4CBBC",
    brightBlack: "#5A6356",
    brightRed: "#F08368",
    brightGreen: "#9FD8AC",
    brightYellow: "#E8C778",
    brightBlue: "#9CBEEC",
    brightMagenta: "#D6B6E4",
    brightCyan: "#8BE0D6",
    brightWhite: "#F2F5EE",
  },
  dark: {
    background: "#141614",
    foreground: "#EAECEA",
    card: "#181C18",
    cardForeground: "#EAECEA",
    primary: "#9AA48C",
    primaryForeground: "#141614",
    secondary: "#1E221E",
    secondaryForeground: "#E0E4E0",
    muted: "#1A1E1A",
    mutedForeground: "#7A8A80",
    border: "rgba(154, 164, 140, 0.12)",
    ring: "#D06F25",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    forest: "#323D2E",
    moss: "#6A8A7A",
    lichen: "#9AA48C",
  },
} as const;

export type ThemeColors = typeof colors.light | typeof colors.dark;

// Matrix product palette — synced from the Figma style library (August 2026).
// Keep raw ramps separate from semantic colors: components should consume a
// semantic role unless they are rendering a color-specific visualization.
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

export const semanticColors = {
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

export const fonts = {
  sans: "Inter" as const,
  sansBold: "Inter_700Bold" as const,
  sansSemiBold: "Inter_600SemiBold" as const,
  sansMedium: "Inter_500Medium" as const,
  mono: "JetBrainsMono_400Regular" as const,
  monoBold: "JetBrainsMono_700Bold" as const,
  // Bricolage Grotesque — brand/display face for big titles only. Use sparingly.
  display: "BricolageGrotesque_700Bold" as const,
  displaySemiBold: "BricolageGrotesque_600SemiBold" as const,
  // Product UI face from the Figma library. The legacy Inter aliases above stay
  // intact so auth and onboarding keep their current appearance during the revamp.
  product: "Geist_400Regular" as const,
  productMedium: "Geist_500Medium" as const,
  productSemiBold: "Geist_600SemiBold" as const,
  productBold: "Geist_700Bold" as const,
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
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  xl2: 20,
  full: 9999,
} as const;

// Product typography from Figma. Bricolage remains reserved for marketing;
// authenticated product UI uses Geist exclusively.
export const typography = {
  h1: {
    fontFamily: fonts.productExtraBold,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
  },
  h2: {
    fontFamily: fonts.productSemiBold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.6,
  },
  h3: {
    fontFamily: fonts.productSemiBold,
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: -0.24,
  },
  large: {
    fontFamily: fonts.productSemiBold,
    fontSize: 18,
    lineHeight: 28,
  },
  body: {
    fontFamily: fonts.product,
    fontSize: 16,
    lineHeight: 28,
  },
  muted: {
    fontFamily: fonts.product,
    fontSize: 14,
    lineHeight: 20,
  },
  overline: {
    fontFamily: fonts.productMedium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.88,
    textTransform: "uppercase" as const,
  },
} as const;

// Typography scale (Paper-synced). Spread into a Text style.
export const type = {
  display: { fontFamily: fonts.sansBold, fontSize: 30, lineHeight: 34, letterSpacing: -0.9 },
  h1: { fontFamily: fonts.sansBold, fontSize: 22, lineHeight: 26, letterSpacing: -0.4 },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 15, lineHeight: 20, letterSpacing: -0.15 },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  bodySm: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  monoSm: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 16 },
  caption: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 14, letterSpacing: 0.2 },
} as const;

// Elevation (RN boxShadow strings, supported on RN 0.76+ / web). Shadows are
// forest-tinted (50, 61, 46) so depth reads botanical rather than neutral-grey.
export const shadows = {
  sm: "0 1px 3px rgba(50, 61, 46, 0.06)",
  card: "0 4px 14px rgba(50, 61, 46, 0.08)",
  raised: "0 8px 22px rgba(50, 61, 46, 0.10)",
  nav: "0 14px 34px rgba(50, 61, 46, 0.16)",
} as const;

export const designShadows = {
  sm: "0 2px 4px rgba(51, 46, 36, 0.06)",
  md: "0 4px 8px rgba(51, 46, 36, 0.08)",
  lg: "0 8px 16px rgba(51, 46, 36, 0.10)",
  lgShine: "inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 16px rgba(51, 46, 36, 0.10)",
} as const;

// Frosted-glass recipe for floating/elevated chrome (tab bar, cards, modals,
// search). `tint`/`panelSurface` are the BlurView fallback fills; `border` is the
// hairline glass edge; `blurIntensity` feeds expo-blur. Botanical-tinted, light.
export const glass = {
  tint: "rgba(250, 250, 249, 0.82)",
  panelSurface: "rgba(252, 252, 251, 0.94)",
  border: "rgba(50, 61, 46, 0.10)",
  borderStrong: "rgba(50, 61, 46, 0.14)",
  highlight: "rgba(255, 255, 255, 0.55)",
  blurIntensity: 88,
} as const;
