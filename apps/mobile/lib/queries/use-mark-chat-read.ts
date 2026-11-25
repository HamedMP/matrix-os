import type { CanonicalChatDetailResponse, CanonicalUpdateChatReadStateRequest } from "@matrix-os/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDrawerStatus } from "expo-router/drawer";
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
  if (!state.markedUnread && throughSeq <= state.readThroughSeq) return null;
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
 * Coalesces reads for two seconds, through only the committed replies delivered
 * to this view. One request runs at a time; navigation, account/computer changes
 * and backgrounding cancel unsent work. A manual reminder survives this visit.
 */
export function useMarkChatRead(detail: CanonicalChatDetailResponse | null, chatId = detail?.record.chat.id ?? null) {
  const queryClient = useQueryClient();
  const { ready, session, userId, computerKey } = useActiveGateway();
  const focused = useIsFocused();
  const drawerOpen = useDrawerStatus() === "open";
  const appActive = useAppActive();
  // Scope serialization also covers a second mounted route for the same chat.
  // Operations are visit-local, never persisted or queued for offline replay.
  const { mutateAsync: acknowledge } = useMutation({
    scope: { id: JSON.stringify(["chat-read", userId, computerKey, chatId]) },
    mutationFn: (operation: () => Promise<void>) => operation(),
    networkMode: "always", retry: false, gcTime: 0,
  });
  const visit = useRef<{
    scope: string; initialVersion: number; blocked: boolean; attempt?: string; dueAt?: number;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const [completion, settled] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; visit.current = null; };
  }, []);

  useEffect(() => {
    const scope = JSON.stringify([userId, computerKey, chatId]);
    if (!focused || !chatId || !ready) {
      visit.current = null;
      return;
    }
    if (visit.current?.scope !== scope) visit.current = null;
    if (!detail || detail.record.chat.id !== chatId || !detail.record.readState) return;
    const version = detail.record.readState.version;
    if (!visit.current) visit.current = { scope, initialVersion: version, blocked: false };
    const current = visit.current;
    current.blocked = detail.record.readState.markedUnread && version > current.initialVersion;
    if (!appActive || drawerOpen || current.blocked) { current.dueAt = undefined; return; }
    const request = chatReadAcknowledgement(detail, current.initialVersion);
    if (!request) { current.dueAt = undefined; return; }
    const attempt = `${request.baseVersion}:${request.throughSeq}`;
    if (current.attempt === attempt || inFlight.current) return;
    // New streamed content replaces the pending acknowledgement without pushing
    // its deadline back. A busy stream must not starve read marking.
    current.dueAt ??= Date.now() + 2_000;
    let cancelled = false;
    const isCurrent = () => !cancelled && mounted.current && visit.current === current;
    const timer = setTimeout(() => {
      inFlight.current = true;
      current.dueAt = Date.now() + 2_000;

      void acknowledge(async () => {
        if (!isCurrent()) return;
        const gateway = await session();
        if (!isCurrent()) return;
        current.attempt = attempt;
        if (!gateway) return;
        // A failed lookup, stale-version refusal or request failure waits for
        // a newer snapshot or another visit, never a retry loop.
        const record = await updateChatReadState(gateway.token, gateway.gatewayUrl, chatId, request);
        if (!isCurrent()) return;
        queryClient.setQueryData<CanonicalChatDetailResponse>(
          mobileQueryKeys.canonicalChatDetail(userId, computerKey, chatId),
          (cached) => cached && cached.record.chat.id === chatId
            ? { ...cached, record: mergeChatReadState(cached.record, record) }
            : cached,
        );
        void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.canonicalChats(userId, computerKey) });
      }).catch((error: unknown) => {
        if (isCurrent()) current.attempt = attempt;
        console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => {
        inFlight.current = false;
        if (mounted.current) settled((value) => value + 1);
      });
    }, Math.max(0, current.dueAt - Date.now()));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [focused, appActive, drawerOpen, ready, detail, chatId, session, queryClient, userId, computerKey, completion, acknowledge]);
}
