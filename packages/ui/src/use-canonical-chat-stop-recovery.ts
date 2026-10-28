import { useCallback, useLayoutEffect, useRef } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatRefresh } from "./canonical-chat-refresh.js";

/** A successful Stop retains one read obligation, independent of SSE health.
 * Backoff is bounded to 10s; navigation/authority changes dispose its timer.
 */
export function useCanonicalChatStopRecovery(
  identity: unknown,
  chatId: string | null | undefined,
  read: (chatId: string) => Promise<CanonicalChatDetailResponse | null>,
) {
  const readRef = useRef(read);
  readRef.current = read;
  const pending = useRef<{ chatId: string; runId: string; refresh: ReturnType<typeof createCanonicalChatRefresh> } | null>(null);
  useLayoutEffect(() => {
    return () => { pending.current?.refresh.dispose(); pending.current = null; };
  }, [identity, chatId]);
  return useCallback((expectedChatId: string, runId: string) => {
    if (!chatId || expectedChatId !== chatId) return;
    pending.current?.refresh.dispose();
    const refresh = createCanonicalChatRefresh(async () => {
      const detail = await readRef.current(expectedChatId);
      return Boolean(detail && detail.record.chat.id === expectedChatId
        && detail.record.activeRun?.runId !== runId);
    });
    pending.current = { chatId, runId, refresh };
    refresh.schedule();
  }, [identity, chatId]);
}
