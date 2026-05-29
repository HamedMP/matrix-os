import { Stack } from "expo-router/stack";
import { colors, fonts } from "@/lib/theme";

export default function AppsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.light.background },
        headerTintColor: colors.light.foreground,
        headerTitleStyle: { fontFamily: fonts.sansSemiBold },
        contentStyle: { backgroundColor: colors.light.background },
      }}
    />
  );
}
