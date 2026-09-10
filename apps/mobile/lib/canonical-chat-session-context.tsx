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
import { AppState } from "react-native";

import {
  createCanonicalChatEventSource,
  reconnectCanonicalChatOnForeground,
  type CanonicalChatInvalidation,
} from "@/lib/canonical-chat-events";
import { applyCanonicalChatEventToCache } from "@/lib/canonical-chat-cache";
import { mobileQueryKeys } from "@/lib/requests";
import { buildGatewayRequestUrl } from "@/lib/requests/http";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";

interface CanonicalChatSessionContextValue {
  /** The chat currently shown, or null for a draft chat not yet created. */
  activeChatId: string | null;
  /** User-driven: opens an existing chat. */
  selectChat: (id: string) => void;
  /**
   * User-driven: starts a blank draft — no chat is created until the first
   * send. Pass a projectId to pre-select it (e.g. "New chat" from within a
   * project's section in the drawer).
   */
  startDraftChat: (projectId?: string | null) => void;
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
  const activeChatIdRef = useRef(activeChatId);
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : null;

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    if (!computerKey || !computer || !userId) return;
    const uid = userId;
    const key = computerKey;
    const eventUrl = buildGatewayRequestUrl(
      `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
      "/api/chats/events",
    );
    const source = createCanonicalChatEventSource({
      url: eventUrl,
      getToken: async () => getToken(),
    });
    eventSourceRef.current = source;
    let listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let detailRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingDetailChatId: string | null = null;
    const scheduleListRefresh = () => {
      if (listRefreshTimer !== undefined) return;
      listRefreshTimer = setTimeout(() => {
        listRefreshTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(uid, key) });
      }, 200);
    };
    const scheduleDetailRefresh = (chatId: string) => {
      pendingDetailChatId = chatId;
      if (detailRefreshTimer !== undefined) return;
      detailRefreshTimer = setTimeout(() => {
        detailRefreshTimer = undefined;
        const pendingChatId = pendingDetailChatId;
        pendingDetailChatId = null;
        if (!pendingChatId) return;
        void queryClient.invalidateQueries({
          queryKey: mobileQueryKeys.canonicalChatDetail(uid, key, pendingChatId),
        });
      }, 200);
    };
    // Subscribe before opening the stream so the initial replay cannot race
    // ahead of the cache consumer.
    const unsubscribe = source.subscribe((event) => {
      const recovery = applyCanonicalChatEventToCache({
        queryClient,
        userId: uid,
        computerKey: key,
        activeChatId: activeChatIdRef.current,
        event,
      });
      if (recovery.refreshList) scheduleListRefresh();
      if (recovery.refreshDetail && activeChatIdRef.current) {
        scheduleDetailRefresh(activeChatIdRef.current);
      }
    });
    const appStateSubscription = reconnectCanonicalChatOnForeground(source, AppState);
    void source.start();
    return () => {
      unsubscribe();
      appStateSubscription.remove();
      if (listRefreshTimer !== undefined) clearTimeout(listRefreshTimer);
      if (detailRefreshTimer !== undefined) clearTimeout(detailRefreshTimer);
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      source.dispose();
    };
  }, [computer, computerKey, getToken, queryClient, userId]);

  const selectChat = useCallback((id: string) => {
    setActiveChatId(id);
    setSelectionOverride(null);
    setSelectedProjectId(null);
  }, []);

  const startDraftChat = useCallback((projectId: string | null = null) => {
    setActiveChatId(null);
    setSelectionOverride(null);
    setSelectedProjectId(projectId);
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
