"use client";

import { useEffect, useRef } from "react";
import type { CanonicalChatReadState, CanonicalUpdateChatReadStateRequest } from "@matrix-os/contracts";

export function useChatReadState({ chatId, state, throughSeq, active, onRead }: {
  chatId: string | null | undefined;
  state: CanonicalChatReadState | undefined;
  throughSeq: number;
  active: boolean;
  onRead?: (chatId: string, input: CanonicalUpdateChatReadStateRequest) => Promise<boolean>;
}) {
  // One selected Chat per view. A manual mark received during this visit must
  // survive refreshes and new replies until the user leaves and reopens it.
  const visit = useRef<{ chatId: string; initialVersion: number; attempt?: string } | null>(null);
  useEffect(() => {
    if (!active || !chatId) { visit.current = null; return; }
    if (!state || !onRead) return;
    if (visit.current?.chatId !== chatId) visit.current = { chatId, initialVersion: state.version };
    const currentVisit = visit.current;
    const acknowledge = (retry = false) => {
      if (!state.unread || (state.markedUnread && state.version > currentVisit.initialVersion)
        || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const key = `${state.version}:${throughSeq}`;
      if (!retry && currentVisit.attempt === key) return;
      currentVisit.attempt = key;
      void onRead(chatId, { type: "mark_read", throughSeq, baseVersion: state.version }).catch((error: unknown) => {
        console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
      });
    };
    const onFocus = () => acknowledge(true);
    acknowledge();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [active, chatId, state, throughSeq, onRead]);
}
