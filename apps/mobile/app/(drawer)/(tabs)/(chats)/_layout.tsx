import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

import { ActiveChatProvider } from "@/components/chat/active-chat";

// The chat screen is this stack's first screen through the navigator's own
// `initialRouteName`, not through `unstable_settings`. The route setting would
// also mark this `index` as an initial route for links, and the root URL `/`
// would then open the chat instead of `app/index.tsx`, skipping the sign-in
// and journey gate on every launch.
//
// The open chat's state sits above the stack: the chat screen and a chat
// opened from a project show the same chat, with one composer between them.
export default function ChatsLayout() {
  const { theme } = useUnistyles();

  return (
    <ActiveChatProvider>
      <Stack
        initialRouteName="index"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.v2.colors.background },
        }}
      />
    </ActiveChatProvider>
  );
}
