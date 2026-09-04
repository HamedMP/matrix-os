import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";

import { useComputerConversations } from "@/lib/queries/use-computer-conversations";
import { mobileQueryKeys } from "@/lib/requests";
import type { GatewayClient } from "@/lib/gateway-client";

interface ChatSessionContextValue {
  /**
   * The conversation currently bound to the live WS connection, or `null` for
   * a draft chat that has no conversation yet — the kernel creates one lazily
   * the moment the first message is sent (see `GatewayClient.sendMessage`).
   */
  activeSessionId: string | null;
  /**
   * Reconciles `activeSessionId` from a WS-driven event (`kernel:init`,
   * `session:switched`) without triggering another `switchSession` call.
   */
  syncActiveSessionId: (id: string) => void;
  /** User-driven: switches the live WS session to an existing conversation. */
  selectConversation: (id: string) => void;
  /** User-driven: starts a blank draft chat — no conversation is created yet. */
  startDraftConversation: () => void;
}

const ChatSessionContext = createContext<ChatSessionContextValue>({
  activeSessionId: null,
  syncActiveSessionId: () => {},
  selectConversation: () => {},
  startDraftConversation: () => {},
});

export function useChatSession(): ChatSessionContextValue {
  return use(ChatSessionContext);
}

export function ChatSessionProvider({
  client,
  children,
}: {
  client: GatewayClient | null;
  children: ReactNode;
}) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { userId } = useAuth();
  const { computer } = useComputerConversations();
  const queryClient = useQueryClient();
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";

  const syncActiveSessionId = useCallback(
    (id: string) => {
      setActiveSessionId((prev) => {
        if (prev === id) return prev;
        // A previously-unseen id means the kernel just lazily created this
        // conversation (first message of a draft chat) — refresh the sidebar.
        void queryClient.invalidateQueries({
          queryKey: mobileQueryKeys.conversations(userId ?? "signed-out", computerKey),
        });
        return id;
      });
    },
    [queryClient, userId, computerKey],
  );

  const selectConversation = useCallback(
    (id: string) => {
      if (!client || id === activeSessionId) return;
      setActiveSessionId(id);
      client.switchSession(id);
    },
    [client, activeSessionId],
  );

  const startDraftConversation = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const value = useMemo<ChatSessionContextValue>(
    () => ({
      activeSessionId,
      syncActiveSessionId,
      selectConversation,
      startDraftConversation,
    }),
    [activeSessionId, syncActiveSessionId, selectConversation, startDraftConversation],
  );

  return <ChatSessionContext value={value}>{children}</ChatSessionContext>;
}
