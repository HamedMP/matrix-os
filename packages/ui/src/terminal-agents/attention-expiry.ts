import type { TerminalAttention } from "./attention.js";

export const DONE_TIMEOUT_MS = 12_000;

/**
 * Times completions out from when each was first shown, so one waiting behind urgent
 * alerts is never dropped unseen. `shownAt` is pruned to the current completions, so
 * it stays bounded by them. Returns a cancel function for the scheduled expiry.
 */
export function scheduleCompletionExpiry(input: {
  shownAt: Map<string, number>;
  alerts: readonly TerminalAttention[];
  visibleDoneKeys: readonly string[];
  expire: (keep: (alert: TerminalAttention) => boolean) => void;
  now?: () => number;
}): () => void {
  const now = input.now ?? Date.now;
  // A tab that stops being done and finishes again gets a fresh time on screen.
  const done = new Set(input.alerts.filter((alert) => alert.kind === "done").map((alert) => alert.key));
  for (const key of input.shownAt.keys()) if (!done.has(key)) input.shownAt.delete(key);
  const at = now();
  for (const key of input.visibleDoneKeys) if (!input.shownAt.has(key)) input.shownAt.set(key, at);
  const expiries = input.alerts.flatMap((alert) => {
    const since = alert.kind === "done" ? input.shownAt.get(alert.key) : undefined;
    return since === undefined ? [] : [since + DONE_TIMEOUT_MS];
  });
  if (expiries.length === 0) return () => undefined;
  const timer = setTimeout(() => {
    const expiredAt = now();
    input.expire((alert) => {
      const since = alert.kind === "done" ? input.shownAt.get(alert.key) : undefined;
      return since === undefined || expiredAt - since < DONE_TIMEOUT_MS;
    });
  }, Math.max(0, Math.min(...expiries) - at));
  return () => clearTimeout(timer);
}
