import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";

import { IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function InstalledIntegrationsLayout() {
  const router = useRouter();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close installed integrations"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={mockColors.ink}
      iconTestID="integrations-close-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );

  return <Stack screenOptions={{
    headerShadowVisible: false,
    headerStyle: { backgroundColor: mockColors.canvas },
    headerTintColor: mockColors.ink,
    headerTitleStyle: { fontFamily: mockFonts.semibold, fontSize: 15 },
    headerBackVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerTitle: "Installed",
    headerLeft: closeButton,
    unstable_headerLeftItems: () => [{
      type: "custom",
      element: closeButton(),
      hidesSharedBackground: true,
    }],
    contentStyle: { backgroundColor: mockColors.canvas },
  }} />;
}
