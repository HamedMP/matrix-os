import { useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { ActiveChatScreen } from "@/components/chat/ActiveChatScreen";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";

export default function ChatScreen() {
  const { isSignedIn, userId } = useAuth();
  const { chat: requestedChat } = useLocalSearchParams();
  const { selectChat } = useCanonicalChatSession();
  const consumedHandoff = useRef<string | null>(null);
  useEffect(() => {
    const target = CanonicalChatIdSchema.safeParse(requestedChat);
    const key = JSON.stringify([userId, target.success ? target.data : null]);
    if (!isSignedIn || !userId || !target.success || consumedHandoff.current === key) return;
    consumedHandoff.current = key;
    selectChat(target.data);
  }, [isSignedIn, userId, requestedChat, selectChat]);
  return <ActiveChatScreen />;
}
