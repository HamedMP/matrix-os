import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import { Stack, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";

import { IconButton } from "@/components/ui";

export default function IntegrationDetailLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const backButton = () => (
    <IconButton
      accessibilityLabel="Back to integrations"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      iconTestID="integrations-back-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.back()}
    />
  );

  return <Stack screenOptions={{
    headerShadowVisible: false,
    headerStyle: { backgroundColor: theme.v2.appColors.canvas },
    headerTintColor: theme.v2.appColors.ink,
    headerTitleStyle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15 },
    headerBackVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerLeft: backButton,
    unstable_headerLeftItems: () => [{
      type: "custom",
      element: backButton(),
      hidesSharedBackground: true,
    }],
    contentStyle: { backgroundColor: theme.v2.appColors.canvas },
  }} />;
}
