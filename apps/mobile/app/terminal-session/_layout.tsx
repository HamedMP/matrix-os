import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";

import { IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function TerminalSessionLayout() {
  const router = useRouter();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close terminal session"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={mockColors.surface}
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
        headerStyle: { backgroundColor: mockColors.terminal },
        headerTintColor: mockColors.surface,
        headerTitleStyle: { fontFamily: mockFonts.mono, fontSize: 14 },
        headerBackVisible: false,
        headerBackButtonDisplayMode: "minimal",
        headerLeft: closeButton,
        unstable_headerLeftItems: () => [{
          type: "custom",
          element: closeButton(),
          hidesSharedBackground: true,
        }],
        contentStyle: { backgroundColor: mockColors.terminal },
      }}
    />
  );
}
