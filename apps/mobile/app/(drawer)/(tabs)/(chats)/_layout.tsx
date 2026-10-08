import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

// The chat screen is this stack's first screen through the navigator's own
// `initialRouteName`, not through `unstable_settings`. The route setting would
// also mark this `index` as an initial route for links, and the root URL `/`
// would then open the chat instead of `app/index.tsx`, skipping the sign-in
// and journey gate on every launch.
export default function ChatsLayout() {
  const { theme } = useUnistyles();

  return (
    <Stack
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.v2.colors.background },
      }}
    />
  );
}
