import { StatusBar } from "expo-status-bar";
import { useUnistyles } from "react-native-unistyles";

interface AppStatusBarProps {
  /**
   * Set by a screen whose top surface keeps one color in both themes. Mounted
   * inside that screen, it overrides the app-wide status bar while the screen
   * is up.
   */
  surface?: "light" | "dark";
}

/**
 * Status bar content that contrasts with the surface under it: the app theme's
 * by default. expo-status-bar's own `auto` follows the system appearance, which
 * stops matching the app once a theme is picked in Settings.
 */
export function AppStatusBar({ surface }: AppStatusBarProps) {
  const { theme } = useUnistyles();
  return <StatusBar style={(surface ?? theme.v2.mode) === "dark" ? "light" : "dark"} />;
}
