import { Stack } from "expo-router";

import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function InstalledIntegrationsLayout() {
  return <Stack screenOptions={{
    headerShadowVisible: false,
    headerStyle: { backgroundColor: mockColors.canvas },
    headerTintColor: mockColors.ink,
    headerTitleStyle: { fontFamily: mockFonts.semibold, fontSize: 15 },
    headerBackButtonDisplayMode: "minimal",
    contentStyle: { backgroundColor: mockColors.canvas },
  }} />;
}
