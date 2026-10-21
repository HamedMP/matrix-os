import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import { Stack, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";

import { IconButton } from "@/components/ui";

export default function SettingsDetailLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();
  // These pages are pushed over Settings, so each goes back to it, by this
  // arrow or by a swipe from the left edge.
  const settingsBackButton = () => (
    <IconButton
      accessibilityLabel="Back to settings"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      buttonSize={32}
      onPress={() => router.back()}
    />
  );
  const backButton = (accessibilityLabel: string) => (
    <IconButton
      accessibilityLabel={accessibilityLabel}
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      buttonSize={32}
      onPress={() => router.back()}
    />
  );
  const settingsBackItems = () => [{
    type: "custom" as const,
    element: settingsBackButton(),
    hidesSharedBackground: true,
  }];

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.v2.appColors.canvas },
        headerTintColor: theme.v2.appColors.ink,
        headerTitleStyle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15 },
        headerBackVisible: false,
        contentStyle: { backgroundColor: theme.v2.appColors.canvas },
      }}
    >
      {[
        ["system", "System"],
        ["account", "Account"],
        ["app-settings", "App settings"],
        ["connect-apps", "Connect Apps"],
        ["billing", "Billing"],
        ["help", "Help"],
      ].map(([name, title]) => (
        <Stack.Screen
          key={name}
          name={name}
          options={{
            title,
            headerLeft: settingsBackButton,
            unstable_headerLeftItems: settingsBackItems,
          }}
        />
      ))}
      {[
        ["support", "Contact support", "Back to help"],
        // Also opened straight from the journey gate, where there is no
        // account screen behind it.
        ["delete-account", "Delete account", "Back"],
      ].map(([name, title, backLabel]) => (
        <Stack.Screen
          key={name}
          name={name}
          options={{
            title,
            headerLeft: () => backButton(backLabel),
            unstable_headerLeftItems: () => [{
              type: "custom",
              element: backButton(backLabel),
              hidesSharedBackground: true,
            }],
          }}
        />
      ))}
    </Stack>
  );
}
