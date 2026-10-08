import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

export default function AgentsLayout() {
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
