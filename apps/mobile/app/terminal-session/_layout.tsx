import { Stack } from "expo-router";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function TerminalSessionLayout() {
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: mockColors.terminal },
        headerTintColor: mockColors.surface,
        headerTitleStyle: { fontFamily: mockFonts.mono, fontSize: 14 },
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: mockColors.terminal },
      }}
    />
  );
}
