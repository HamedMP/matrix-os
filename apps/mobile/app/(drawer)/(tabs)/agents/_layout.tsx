import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

import { ChatHandoffProvider } from "@/components/agents/chat-handoff";
import { CreationAttemptProvider } from "@/components/agents/creation-attempt";

export default function AgentsLayout() {
  const { theme } = useUnistyles();

  return (
    <CreationAttemptProvider>
      <ChatHandoffProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.v2.colors.background },
          }}
        />
      </ChatHandoffProvider>
    </CreationAttemptProvider>
  );
}
