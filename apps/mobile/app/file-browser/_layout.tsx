import { Pressable, Text } from "react-native";
import { Stack, useRouter } from "expo-router";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function FileBrowserLayout() {
  const router = useRouter();

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
          headerLeft: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Close file browser" onPress={() => router.dismiss()}>
              <Text style={{ fontFamily: mockFonts.medium, fontSize: 15, color: mockColors.blue }}>Close</Text>
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="[...path]" />
    </Stack>
  );
}
