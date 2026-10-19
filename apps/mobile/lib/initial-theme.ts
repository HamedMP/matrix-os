import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";

// Kept apart from lib/storage so the theme can be read before anything else
// loads: the app's styles ask for it as they are set up.

/** Where the app's settings are kept on the device. */
export const SETTINGS_KEY = "matrix_os_settings";

function savedThemePreference(): "light" | "dark" | "system" {
  try {
    const raw = SecureStore.getItem(SETTINGS_KEY);
    if (!raw) return "system";
    const theme = (JSON.parse(raw) as { theme?: unknown } | null)?.theme;
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch (error: unknown) {
    console.warn("[mobile] saved theme unreadable at launch", error instanceof Error ? error.name : "unknown");
    return "system";
  }
}

/**
 * The theme the first frame is drawn in: the one chosen in Settings, or the
 * device's appearance. Read synchronously, so no screen starts light and then
 * turns dark once the settings have loaded.
 */
export function initialMobileTheme(): "light" | "dark" {
  const preference = savedThemePreference();
  if (preference !== "system") return preference;
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}
