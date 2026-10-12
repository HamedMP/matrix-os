import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

import { CreationAttemptProvider } from "@/components/agents/creation-attempt";

export default function AgentsLayout() {
  const { theme } = useUnistyles();

  return (
    <CreationAttemptProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.v2.colors.background },
        }}
      />
    </CreationAttemptProvider>
  );
}
