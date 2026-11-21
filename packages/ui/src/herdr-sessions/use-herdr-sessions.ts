import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeHerdrSession, HIDDEN_HERDR_SESSIONS, loadHerdrSessions,
  type HerdrSessionList, type HerdrSessionsRequest,
} from "./herdr-sessions-client.js";

const DEFAULT_INTERVAL_MS = 5_000;
export const HERDR_CLOSE_FAILED_MESSAGE = "Could not close the Herdr session. Try again.";

/**
 * The owner's Herdr sessions, refreshed every few seconds while mounted. A
 * failed load hides the group rather than showing an error: no Herdr, no UI.
 */
export function useHerdrSessions(options: { request: HerdrSessionsRequest | null; intervalMs?: number }) {
  const { request } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [list, setList] = useState<HerdrSessionList>(HIDDEN_HERDR_SESSIONS);
  const [closingIds, setClosingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!request) return;
    const started = ++generation.current;
    try {
      const next = await loadHerdrSessions(request);
      if (started === generation.current) setList(next);
    } catch (loadError: unknown) {
      console.warn("[herdr-sessions] load failed", loadError instanceof Error ? loadError.name : "unknown_error");
      if (started === generation.current) setList(HIDDEN_HERDR_SESSIONS);
    }
  }, [request]);

  useEffect(() => {
    if (!request) return undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [request, refresh, intervalMs]);

  const close = useCallback(async (id: string): Promise<boolean> => {
    if (!request) return false;
    setClosingIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
    setError(null);
    try {
      await closeHerdrSession(request, id);
      // The row leaves only once the core confirmed the terminal ended.
      await refresh();
      return true;
    } catch (closeError: unknown) {
      console.warn("[herdr-sessions] close failed", closeError instanceof Error ? closeError.name : "unknown_error");
      setError(HERDR_CLOSE_FAILED_MESSAGE);
      return false;
    } finally {
      setClosingIds((ids) => ids.filter((candidate) => candidate !== id));
    }
  }, [request, refresh]);

  return { list, closingIds, error, refresh, close };
}
