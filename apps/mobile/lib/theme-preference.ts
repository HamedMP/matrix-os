import { Appearance, type ColorSchemeName } from "react-native";
import { UnistylesRuntime } from "react-native-unistyles";

import { getSettings, type AppSettings } from "@/lib/storage";

export type MobileThemePreference = AppSettings["theme"];

let currentPreference: MobileThemePreference = "system";

function resolveTheme(
  preference: MobileThemePreference,
  colorScheme: ColorSchemeName = Appearance.getColorScheme(),
): "light" | "dark" {
  if (preference !== "system") return preference;
  return colorScheme === "dark" ? "dark" : "light";
}

export function applyMobileThemePreference(preference: MobileThemePreference): void {
  currentPreference = preference;
  UnistylesRuntime.setTheme(resolveTheme(preference));
}

export function startMobileThemeController(): () => void {
  let active = true;
  void getSettings()
    .then((settings) => {
      if (active) applyMobileThemePreference(settings.theme);
    })
    .catch((error: unknown) => {
      console.warn("[mobile] theme preference unavailable", error instanceof Error ? error.name : "unknown");
    });

  const subscription = Appearance.addChangeListener(({ colorScheme }) => {
    if (currentPreference === "system") {
      UnistylesRuntime.setTheme(resolveTheme("system", colorScheme));
    }
  });

  return () => {
    active = false;
    subscription.remove();
  };
}
