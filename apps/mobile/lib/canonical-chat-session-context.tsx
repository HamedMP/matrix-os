import type {
  CanonicalChatContentFrame,
  CanonicalChatDetailResponse,
  CanonicalChatModelSelection,
} from "@matrix-os/contracts";
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

import { applyCanonicalChatContentFrames } from "@/lib/canonical-chat-content";
import { createCanonicalChatEventSource, type CanonicalChatInvalidation } from "@/lib/canonical-chat-events";
import { mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";

// A snapshot fetch normally lands within a few frames; this only bounds the
// queue if one never does.
const MAX_WAITING_FRAMES = 200;

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
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : null;

  useEffect(() => {
    if (!computerKey || !computer) return;
    const source = createCanonicalChatEventSource({
      gatewayUrl: `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
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
    const uid = userId ?? "signed-out";
    const key = computerKey ?? "none";
    const chatsKey = mobileQueryKeys.canonicalChats(uid, key);
    const detailKey = mobileQueryKeys.canonicalChatDetail(uid, key, activeChatId ?? "none");
    // Streamed frames for the open chat that don't fit its cached detail yet:
    // the detail is still loading, or a frame was missed. They wait here for a
    // snapshot instead of being dropped, so streaming picks up right after it.
    let waitingFrames: CanonicalChatContentFrame[] = [];
    const applyWaitingFrames = () => {
      const cached = queryClient.getQueryData<CanonicalChatDetailResponse>(detailKey);
      if (!cached) return;
      const { detail, unapplied } = applyCanonicalChatContentFrames(cached, waitingFrames);
      waitingFrames = unapplied;
      if (detail !== cached) queryClient.setQueryData(detailKey, detail);
    };

    return source.subscribe((event) => {
      if (event.type === "chat.full_refresh") {
        void queryClient.invalidateQueries({ queryKey: chatsKey });
        if (activeChatId) void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      // Each streamed piece of text is a `run.message` event: it grows the
      // open transcript but changes nothing the chat list shows.
      if (event.eventType !== "run.message") {
        void queryClient.invalidateQueries({ queryKey: chatsKey });
      }
      if (event.chatId !== activeChatId) return;
      if (!event.content) {
        void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }

      const wasWaiting = waitingFrames.length > 0;
      waitingFrames = [...waitingFrames, event.content].slice(-MAX_WAITING_FRAMES);
      applyWaitingFrames();
      // The first frame that doesn't fit triggers one snapshot fetch; frames
      // arriving while it loads just queue up behind it.
      if (waitingFrames.length > 0 && !wasWaiting) {
        void queryClient.invalidateQueries({ queryKey: detailKey }).then(applyWaitingFrames);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, computerKey, userId, queryClient]);

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
