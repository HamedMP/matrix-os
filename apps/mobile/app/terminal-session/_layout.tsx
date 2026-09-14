import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";

import { IconButton } from "@/components/ui";
import { appColors, appFonts } from "@/lib/theme-v2";

export default function TerminalSessionLayout() {
  const router = useRouter();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close terminal session"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={appColors.light.surface}
      iconTestID="terminal-close-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: appColors.light.terminal },
        headerTintColor: appColors.light.surface,
        headerTitleStyle: { fontFamily: appFonts.mono, fontSize: 14 },
        headerBackVisible: false,
        headerBackButtonDisplayMode: "minimal",
        headerLeft: closeButton,
        unstable_headerLeftItems: () => [{
          type: "custom",
          element: closeButton(),
          hidesSharedBackground: true,
        }],
        contentStyle: { backgroundColor: appColors.light.terminal },
      }}
    />
  );
}
