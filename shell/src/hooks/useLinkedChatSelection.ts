"use client";
import { useEffect, useRef } from "react";

/**
 * Selects a deep-linked Chat (`?chat=<id>`) exactly once. The id can arrive
 * only after hydration, because the server snapshot of the URL is empty, so
 * this runs as an effect instead of relying on the initial selection state.
 * Later user choices are never overridden.
 */
export function useLinkedChatSelection({ chatId, blocked, activeChatId, select }: {
  chatId: string | null | undefined;
  blocked: boolean;
  activeChatId: string | undefined;
  select: (chatId: string) => void;
}): void {
  const consumed = useRef(false);
  useEffect(() => {
    if (!chatId || blocked || consumed.current) return;
    consumed.current = true;
    if (activeChatId !== chatId) select(chatId);
  }, [chatId, blocked, activeChatId, select]);
}
