import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { ActiveChatScreen } from "@/components/chat/ActiveChatScreen";
import { useBackOr } from "@/components/projects/use-back-or";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";

/**
 * A chat opened from a project. It sits above the project in the Chats stack,
 * so back returns to the project's chats, where another one can be opened.
 */
export default function ProjectChatRoute() {
  const params = useLocalSearchParams<{ projectId?: string | string[]; chatId?: string | string[] }>();
  const projectId = typeof params.projectId === "string" ? params.projectId : null;
  const chatId = typeof params.chatId === "string" ? params.chatId : null;
  const router = useRouter();
  const goBack = useBackOr(projectId ? `/projects/${encodeURIComponent(projectId)}` : "/projects");
  const { activeChatId, selectChat } = useCanonicalChatSession();

  // A project's rows open their chat before they come here. A link that names
  // another chat opens that one, on arrival only: the open chat is not taken
  // back from whatever changes it later.
  const arrivedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!chatId || arrivedAt.current === chatId) return;
    arrivedAt.current = chatId;
    if (activeChatId !== chatId) selectChat(chatId);
  }, [chatId, activeChatId, selectChat]);

  // A new chat in a project starts from the project's own composer, which
  // `newChat` puts the cursor in.
  const startProjectChat = () => {
    router.dismissTo((projectId
      ? { pathname: "/projects/[projectId]", params: { projectId, newChat: "1" } }
      : "/projects") as never);
  };

  return <ActiveChatScreen onBack={goBack} onNewChat={startProjectChat} />;
}
