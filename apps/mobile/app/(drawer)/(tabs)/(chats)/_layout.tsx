import { useUnistyles } from "react-native-unistyles";
import { Stack } from "expo-router";

import { ActiveChatProvider } from "@/components/chat/active-chat";

// A link that opens a screen of this stack directly puts the chat screen
// beneath it. The anchor only does that: the root URL `/` still opens
// `app/index.tsx`, the sign-in and journey gate, which shares the URL.
export const unstable_settings = { anchor: "index" };

// The open chat's state sits above the stack: the chat screen and a chat
// opened from a project show the same chat, with one composer between them.
export default function ChatsLayout() {
  const { theme } = useUnistyles();

  return (
    <ActiveChatProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.v2.colors.background },
        }}
      />
    </ActiveChatProvider>
  );
}
