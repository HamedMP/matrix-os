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
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
} as const;

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  xl2: 20,
  full: 9999,
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
