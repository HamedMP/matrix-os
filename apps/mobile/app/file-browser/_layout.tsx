import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useRouter } from "expo-router";

import { IconButton } from "@/components/ui";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function FileBrowserLayout() {
  const router = useRouter();
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close file browser"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={mockColors.ink}
      iconTestID="file-browser-close-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );
  const backButton = () => (
    <IconButton
      accessibilityLabel="Back to previous folder"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={mockColors.ink}
      iconTestID="file-browser-back-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.back()}
    />
  );

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: mockColors.canvas },
        headerTintColor: mockColors.ink,
        headerTitleStyle: { fontFamily: mockFonts.semibold, fontSize: 15 },
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: mockColors.canvas },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Files",
          headerBackVisible: false,
          headerLeft: closeButton,
          unstable_headerLeftItems: () => [{
            type: "custom",
            element: closeButton(),
            hidesSharedBackground: true,
          }],
        }}
      />
      <Stack.Screen
        name="[...path]"
        options={{
          headerBackVisible: false,
          headerLeft: backButton,
          unstable_headerLeftItems: () => [{
            type: "custom",
            element: backButton(),
            hidesSharedBackground: true,
          }],
        }}
      />
      <Stack.Screen
        name="file"
        options={{
          headerBackVisible: false,
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
