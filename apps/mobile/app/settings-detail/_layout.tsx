import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";

import { IconButton } from "@/components/ui";

export default function SettingsDetailLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close settings"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );
  const backButton = () => (
    <IconButton
      accessibilityLabel="Back to help"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.back()}
    />
  );
  const closeItems = () => [{
    type: "custom" as const,
    element: closeButton(),
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
        ["billing", "Billing"],
        ["help", "Help"],
      ].map(([name, title]) => (
        <Stack.Screen
          key={name}
          name={name}
          options={{
            title,
            headerLeft: closeButton,
            unstable_headerLeftItems: closeItems,
          }}
        />
      ))}
      <Stack.Screen
        name="support"
        options={{
          title: "Contact support",
          headerLeft: backButton,
          unstable_headerLeftItems: () => [{
            type: "custom",
            element: backButton(),
            hidesSharedBackground: true,
          }],
        }}
      />
    </Stack>
  );
}
