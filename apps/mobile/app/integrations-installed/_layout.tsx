import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";

import { IconButton } from "@/components/ui";

export default function InstalledIntegrationsLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close installed integrations"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      iconTestID="integrations-close-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );

  return <Stack screenOptions={{
    headerShadowVisible: false,
    headerStyle: { backgroundColor: theme.v2.appColors.canvas },
    headerTintColor: theme.v2.appColors.ink,
    headerTitleStyle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15 },
    headerBackVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerTitle: "Installed",
    headerLeft: closeButton,
    unstable_headerLeftItems: () => [{
      type: "custom",
      element: closeButton(),
      hidesSharedBackground: true,
    }],
    contentStyle: { backgroundColor: theme.v2.appColors.canvas },
  }} />;
}
