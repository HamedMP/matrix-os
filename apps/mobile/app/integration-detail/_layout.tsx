import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import { Stack, useRouter } from "expo-router";

import { IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function IntegrationDetailLayout() {
  const router = useRouter();
  const backButton = () => (
    <IconButton
      accessibilityLabel="Back to integrations"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={mockColors.ink}
      iconTestID="integrations-back-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.back()}
    />
  );

  return <Stack screenOptions={{
    headerShadowVisible: false,
    headerStyle: { backgroundColor: mockColors.canvas },
    headerTintColor: mockColors.ink,
    headerTitleStyle: { fontFamily: mockFonts.semibold, fontSize: 15 },
    headerBackVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerLeft: backButton,
    unstable_headerLeftItems: () => [{
      type: "custom",
      element: backButton(),
      hidesSharedBackground: true,
    }],
    contentStyle: { backgroundColor: mockColors.canvas },
  }} />;
}
