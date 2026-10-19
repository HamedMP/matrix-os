import { useColorScheme } from "react-native";

import { semanticColorsByMode, type ThemeMode } from "@/lib/theme-v2";

/**
 * The colour scheme the startup screen is drawn in. The native splash follows
 * the device's appearance and knows nothing of the theme picked in Settings,
 * so the screen that takes over from it follows the device too; the app's own
 * theme starts with the first screen after startup.
 */
export function useStartupMode(): ThemeMode {
  return useColorScheme() === "dark" ? "dark" : "light";
}

/** Text colours that read on the startup screen's ground, for the status content handed to it. */
export function useStartupColors() {
  const colors = semanticColorsByMode[useStartupMode()];
  return { text: colors.textDefault, textSubtle: colors.textSubtle };
}
