export const colors = {
  light: {
    background: "#FAFAF9",
    foreground: "#1c1917",
    card: "#FFFFFF",
    cardForeground: "#1c1917",
    primary: "#8CC7BE",
    primaryForeground: "#141614",
    secondary: "#F2F5F3",
    secondaryForeground: "#1c1917",
    muted: "#F2F5F3",
    mutedForeground: "#6B7280",
    border: "#E5E5E4",
    ring: "#8CC7BE",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    forest: "#323D2E",
    moss: "#6A8A7A",
    lichen: "#9AA48C",
  },
  dark: {
    background: "#141614",
    foreground: "#EAECEA",
    card: "#181C18",
    cardForeground: "#EAECEA",
    primary: "#8CC7BE",
    primaryForeground: "#141614",
    secondary: "#1E221E",
    secondaryForeground: "#E0E4E0",
    muted: "#1A1E1A",
    mutedForeground: "#7A8A80",
    border: "rgba(140, 199, 190, 0.12)",
    ring: "#8CC7BE",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
    forest: "#8CC7BE",
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
  full: 9999,
} as const;
