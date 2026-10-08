import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

// Keeps Apps beneath Files and Connect Apps when a link opens one of them
// directly, as the Connect Apps sign-in return (`matrixos://integrations`) does.
export const unstable_settings = { initialRouteName: "apps" };

export default function AppsLayout() {
  const { theme } = useUnistyles();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.v2.colors.background },
      }}
    />
  );
}
