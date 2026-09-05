import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";

import { createCanonicalChatEventSource, type CanonicalChatInvalidation } from "@/lib/canonical-chat-events";
import { mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";

interface CanonicalChatSessionContextValue {
  /** The chat currently shown, or null for a draft chat not yet created. */
  activeChatId: string | null;
  /** User-driven: opens an existing chat. */
  selectChat: (id: string) => void;
  /** User-driven: starts a blank draft — no chat is created until the first send. */
  startDraftChat: () => void;
  /**
   * Binds the id of a chat the draft flow just lazily created on first send —
   * unlike `selectChat`, this does not reset `selectionOverride` (the
   * selection that was just used to create it stays authoritative).
   */
  bindDraftChatId: (id: string) => void;
  /** The model/harness the user explicitly picked for the active chat, if any. */
  selectionOverride: CanonicalChatModelSelection | null;
  setSelectionOverride: (selection: CanonicalChatModelSelection) => void;
  /**
   * The Project a draft chat should be created in, if the user picked one.
   * Only meaningful before the chat exists -- an existing chat's project is
   * set once at creation (see use-send-chat-message.ts) and isn't repointed
   * from here.
   */
  selectedProjectId: string | null;
  setSelectedProjectId: (projectId: string | null) => void;
  /** Fires on any invalidation for the active chat or a full-refresh signal. */
  subscribe: (listener: (event: CanonicalChatInvalidation) => void) => () => void;
}

const CanonicalChatSessionContext = createContext<CanonicalChatSessionContextValue>({
  activeChatId: null,
  selectChat: () => {},
  startDraftChat: () => {},
  bindDraftChatId: () => {},
  selectionOverride: null,
  setSelectionOverride: () => {},
  selectedProjectId: null,
  setSelectedProjectId: () => {},
  subscribe: () => () => {},
});

export function useCanonicalChatSession(): CanonicalChatSessionContextValue {
  return use(CanonicalChatSessionContext);
}

export function CanonicalChatSessionProvider({ children }: { children: ReactNode }) {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [selectionOverride, setSelectionOverride] = useState<CanonicalChatModelSelection | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { getToken, userId } = useAuth();
  const { computer } = useCanonicalChats();
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<ReturnType<typeof createCanonicalChatEventSource> | null>(null);
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : null;

  useEffect(() => {
    if (!computerKey || !computer) return;
    // Hosted routed computers terminate WebSocket upgrades on the canonical
    // platform origin (not the `/vm/<handle>` path) and resolve the machine
    // from the `runtime` query alone — matching GatewayClient's `wsBaseUrl`.
    // gatewayPath is `/vm/<handle>` or `/vm/<handle>?runtime=<slot>`; only
    // that trailing query (if any) carries over.
    const queryIndex = computer.gatewayPath.indexOf("?");
    const routingQuery = queryIndex === -1 ? "" : computer.gatewayPath.slice(queryIndex);
    const wsUrl = `${HOSTED_GATEWAY_URL}/ws/chats/events${routingQuery}`.replace(/^http/, "ws");
    const source = createCanonicalChatEventSource({
      wsUrl,
      getToken: async () => getToken(),
    });
    eventSourceRef.current = source;
    source.connect();
    return () => {
      eventSourceRef.current = null;
      source.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computerKey]);

  useEffect(() => {
    const source = eventSourceRef.current;
    if (!source) return;
    return source.subscribe((event) => {
      const uid = userId ?? "signed-out";
      const key = computerKey ?? "none";
      if (event.type === "chat.full_refresh") {
        void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(uid, key) });
        if (activeChatId) {
          void queryClient.invalidateQueries({
            queryKey: mobileQueryKeys.canonicalChatDetail(uid, key, activeChatId),
          });
        }
        return;
      }
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(uid, key) });
      if (event.chatId === activeChatId) {
        void queryClient.invalidateQueries({
          queryKey: mobileQueryKeys.canonicalChatDetail(uid, key, event.chatId),
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, computerKey, userId, queryClient]);

  const selectChat = useCallback((id: string) => {
    setActiveChatId(id);
    setSelectionOverride(null);
    setSelectedProjectId(null);
  }, []);

  const startDraftChat = useCallback(() => {
    setActiveChatId(null);
    setSelectionOverride(null);
    setSelectedProjectId(null);
  }, []);

  const bindDraftChatId = useCallback((id: string) => {
    setActiveChatId(id);
  }, []);

  const subscribe = useCallback((listener: (event: CanonicalChatInvalidation) => void) => {
    const source = eventSourceRef.current;
    if (!source) return () => {};
    return source.subscribe(listener);
  }, []);

  const value = useMemo<CanonicalChatSessionContextValue>(
    () => ({
      activeChatId,
      selectChat,
      startDraftChat,
      bindDraftChatId,
      selectionOverride,
      setSelectionOverride,
      selectedProjectId,
      setSelectedProjectId,
      subscribe,
    }),
    [
      activeChatId,
      selectChat,
      startDraftChat,
      bindDraftChatId,
      selectionOverride,
      selectedProjectId,
      subscribe,
    ],
  );

  return <CanonicalChatSessionContext value={value}>{children}</CanonicalChatSessionContext>;
}
