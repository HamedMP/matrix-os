import { useColorScheme } from "react-native";

export const colors = {
  light: {
    background: "#ece5f0",
    foreground: "#1c1917",
    card: "#ffffff",
    cardForeground: "#1c1917",
    primary: "#c2703a",
    primaryForeground: "#ffffff",
    secondary: "#f0eaf4",
    secondaryForeground: "#44403c",
    muted: "#f0eaf4",
    mutedForeground: "#78716c",
    border: "#d8d0de",
    ring: "#c2703a",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
  },
  dark: {
    background: "#1c1917",
    foreground: "#ece5f0",
    card: "#292524",
    cardForeground: "#ece5f0",
    primary: "#c2703a",
    primaryForeground: "#ffffff",
    secondary: "#3b3536",
    secondaryForeground: "#d6d3d1",
    muted: "#3b3536",
    mutedForeground: "#a8a29e",
    border: "#44403c",
    ring: "#c2703a",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#eab308",
  },
} as const;

export type ThemeColors = typeof colors.light;

export function useThemeColors(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === "dark" ? colors.dark : colors.light;
}

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
