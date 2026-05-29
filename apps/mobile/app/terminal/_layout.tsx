import { Stack } from "expo-router";
import { colors, fonts } from "@/lib/theme";

export default function TerminalLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#0f120f" },
        headerTitleStyle: { fontFamily: fonts.sansSemiBold },
        headerTintColor: colors.dark.foreground,
      }}
    />
  );
}
