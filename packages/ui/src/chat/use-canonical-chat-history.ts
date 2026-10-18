import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

export interface CanonicalChatHistoryControls {
  hasEarlier: boolean;
  loading: boolean;
  error: string | null;
  loadEarlier(): Promise<void>;
}
// Explicit per-view memory bound, with visible feedback when reached.
export const MAX_LOADED_CHAT_MESSAGES = 10_000;
function unionById<T extends { id: string }>(older: T[], newer: T[]): T[] {
  const ids = new Set(newer.map(item => item.id)); // Bounded by the loaded snapshot.
  return [...older.filter(item => !ids.has(item.id)), ...newer];
}
/** Retain only the prefix outside the authoritative fresh message window. */
export function mergeLoadedChatHistory(
  fresh: CanonicalChatDetailResponse,
  current: CanonicalChatDetailResponse | null,
): CanonicalChatDetailResponse {
  if (!current || current.record.chat.id !== fresh.record.chat.id) return fresh;
  const firstSeq = fresh.messages[0]?.seq;
  if (firstSeq === undefined || !current.messages.some(message => message.seq < firstSeq)) return fresh;
  // A disconnected client may have missed whole pages. Keep the fresh cursor
  // until those pages are loaded; joining disjoint windows would hide the gap.
  if ((current.messages.at(-1)?.seq ?? 0) < firstSeq - 1) return fresh;
  const messages = [...current.messages.filter(message => message.seq < firstSeq), ...fresh.messages];
  if (messages.length > MAX_LOADED_CHAT_MESSAGES) return fresh;
  const turnIds = new Set(messages.flatMap(message => message.turnId ? [message.turnId] : []));
  const runs = unionById(current.runs, fresh.runs).filter(run => turnIds.has(run.turnId));
  const runIds = new Set(runs.map(run => run.id));
  return { ...fresh, messages,
    turns: unionById(current.turns, fresh.turns).filter(turn => turnIds.has(turn.id)),
    runs, activities: unionById(current.activities, fresh.activities).filter(activity => runIds.has(activity.runId)),
    nextCursor: current.nextCursor,
  };
}

export function useCanonicalChatHistory({ detail, activeChatId, loadPage, update }: {
  detail: CanonicalChatDetailResponse | null;
  activeChatId: string | null | undefined;
  loadPage(chatId: string, cursor: string): Promise<CanonicalChatDetailResponse>;
  /** Applies synchronously against the latest live snapshot, including streaming updates. */
  update(apply: (current: CanonicalChatDetailResponse | null) => CanonicalChatDetailResponse | null): void;
}): CanonicalChatHistoryControls {
  const live = useRef({ detail, activeChatId, loadPage, epoch: 0 });
  if (live.current.activeChatId !== activeChatId || live.current.loadPage !== loadPage) live.current.epoch += 1;
  live.current = { detail, activeChatId, loadPage, epoch: live.current.epoch };
  useEffect(() => () => { live.current.epoch += 1; }, []);
  const inFlight = useRef<number | null>(null);
  const [state, setState] = useState<{ epoch: number; loading: boolean; error: string | null }>({ epoch: 0, loading: false, error: null });
  const loadEarlier = useCallback(async () => {
    const { detail: start, activeChatId: chatId, epoch } = live.current;
    if (!start?.nextCursor || start.record.chat.id !== chatId || inFlight.current === epoch) return;
    if (start.messages.length >= MAX_LOADED_CHAT_MESSAGES) {
      setState({ epoch, loading: false, error: "History display limit reached. The original archive retains the full conversation." });
      return;
    }
    inFlight.current = epoch;
    setState({ epoch, loading: true, error: null });
    try {
      const older = await loadPage(chatId, start.nextCursor);
      if (live.current.epoch !== epoch) return;
      if (older.record.chat.id !== chatId || older.nextCursor === start.nextCursor
        || !older.messages.length || older.messages.at(-1)!.seq !== start.messages[0]!.seq - 1) throw new Error("InvalidHistoryPage");
      if (start.messages.length + older.messages.length > MAX_LOADED_CHAT_MESSAGES) {
        setState({ epoch, loading: false, error: "History display limit reached. The original archive retains the full conversation." });
        return;
      }
      let limitReached = false;
      update(current => {
        if (current?.record.chat.id !== chatId || current.nextCursor !== start.nextCursor) return current;
        if (current.messages.length + older.messages.length > MAX_LOADED_CHAT_MESSAGES) { limitReached = true; return current; }
        const { nextCursor: _, ...merged } = mergeLoadedChatHistory(current, older);
        return { ...merged, ...(older.nextCursor ? { nextCursor: older.nextCursor } : {}) };
      });
      setState({ epoch, loading: false, error: limitReached ? "History display limit reached. The original archive retains the full conversation." : null });
    } catch (error: unknown) {
      if (live.current.epoch !== epoch) return;
      console.warn("[canonical-chat] earlier history unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState({ epoch, loading: false, error: "Earlier messages could not be loaded. Try again." });
    } finally { if (inFlight.current === epoch) inFlight.current = null; }
  }, [loadPage, update]);
  return { hasEarlier: Boolean(detail?.record.chat.id === activeChatId && detail?.nextCursor),
    loading: state.epoch === live.current.epoch && state.loading,
    error: state.epoch === live.current.epoch ? state.error : null, loadEarlier };
}
