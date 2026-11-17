import type { CanonicalChatDetailResponse, CanonicalUpdateChatReadStateRequest } from "@matrix-os/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { mobileQueryKeys, updateChatReadState } from "@/lib/requests";
import { mergeChatReadState } from "@/lib/shared-chat-state";

/**
 * What an open chat owes the server so that it stops showing as unread
 * ("Completed" in the chat lists), or null when it owes nothing. Desktop's
 * rule (useChatReadState in @matrix-os/ui): read through the last finished
 * reply, at the read version on screen, unless someone marked the chat unread
 * while it was open.
 */
type MarkReadRequest = Extract<CanonicalUpdateChatReadStateRequest, { type: "mark_read" }>;

export function chatReadAcknowledgement(
  detail: CanonicalChatDetailResponse,
  initialVersion: number,
): MarkReadRequest | null {
  const state = detail.record.readState;
  if (!state?.unread) return null;
  if (state.markedUnread && state.version > initialVersion) return null;
  let throughSeq = 0;
  for (const message of detail.messages) {
    if (message.role === "assistant" && message.state === "committed") throughSeq = Math.max(throughSeq, message.seq);
  }
  return { type: "mark_read", throughSeq, baseVersion: state.version };
}

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * Marks the chat on screen read while the person can see it: the screen is
 * focused and the app is in the foreground. Each read version is acknowledged
 * once, so a refusal (the version moved on) waits for the chat to be read
 * again instead of repeating.
 */
export function useMarkChatRead(detail: CanonicalChatDetailResponse | null) {
  const queryClient = useQueryClient();
  const { ready, session, userId, computerKey } = useActiveGateway();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const visit = useRef<{ chatId: string; initialVersion: number; attempt?: string } | null>(null);

  useEffect(() => {
    if (!focused || !detail) {
      visit.current = null;
      return;
    }
    const chatId = detail.record.chat.id;
    const version = detail.record.readState?.version ?? 0;
    if (visit.current?.chatId !== chatId) visit.current = { chatId, initialVersion: version };
    const current = visit.current;
    // An attempt is spent only once it can be sent.
    if (!appActive || !ready) return;
    const request = chatReadAcknowledgement(detail, current.initialVersion);
    if (!request) return;
    const attempt = `${request.baseVersion}:${request.throughSeq}`;
    if (current.attempt === attempt) return;
    current.attempt = attempt;

    void (async () => {
      const gateway = await session();
      if (!gateway) return;
      const record = await updateChatReadState(gateway.token, gateway.gatewayUrl, chatId, request);
      queryClient.setQueryData<CanonicalChatDetailResponse>(
        mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId),
        (cached) => cached && cached.record.chat.id === chatId
          ? { ...cached, record: mergeChatReadState(cached.record, record) }
          : cached,
      );
      // The chat lists (project lists share this key's start) show the chat as read.
      void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(userId, computerKey) });
    })().catch((error: unknown) => {
      console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
    });
  }, [focused, appActive, ready, detail, session, queryClient, userId, computerKey]);
}
