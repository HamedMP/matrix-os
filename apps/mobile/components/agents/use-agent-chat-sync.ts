import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createCanonicalChatCacheSync } from "@/lib/canonical-chat-cache-sync";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { mobileQueryKeys } from "@/lib/requests/query-keys";

// The session's own sync refreshes the chat list on every event. This one is
// given a key no query has, so the list is not read a second time.
const NO_CHAT_LIST = ["mobile", "agent-chat-sync", "no-list"] as const;

/**
 * Keeps an agent's chat and status in step with the chat event stream while
 * its screen is open. The session does this only for the Chats tab's active
 * chat, which an agent's chat is not.
 */
export function useAgentChatSync(chatId: string | null): void {
  const queryClient = useQueryClient();
  const { subscribe, streamLive, activeChatId } = useCanonicalChatSession();
  const { userId, computerKey, gatewayUrl } = useActiveGateway();
  // A chat that is also open in the Chats tab is already kept in step.
  const watched = chatId !== null && chatId !== activeChatId ? chatId : null;

  useEffect(() => {
    if (!watched || !gatewayUrl) return;
    const sync = createCanonicalChatCacheSync({
      queryClient,
      chatsKey: NO_CHAT_LIST,
      activeChat: {
        chatId: watched,
        detailKey: mobileQueryKeys.canonicalChatDetail(userId, computerKey, watched),
        botKey: mobileQueryKeys.botChat(userId, gatewayUrl, watched),
      },
    });
    const unsubscribe = subscribe(sync.handle);
    return () => {
      unsubscribe();
      sync.dispose();
    };
    // `streamLive` is here so that a stream opened after this screen, as for
    // another computer, is listened to once it is up.
  }, [watched, gatewayUrl, userId, computerKey, queryClient, subscribe, streamLive]);
}
