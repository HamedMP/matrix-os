import type { TerminalScrollState } from "@matrix-os/contracts";

export const NATIVE_HISTORY_RESPONSE_BUDGET_MS = 4_000;
/** The longest wait between queries while the computer answers without a history. */
export const NATIVE_HISTORY_EMPTY_BACKOFF_MAX_MS = 30_000;
const NATIVE_HISTORY_POLL_MS = 500;

/** Bounded, coalescing transport for the single rail of an attached terminal. */
export function createTerminalNativeHistory(options: {
  send(frame: { type: "scroll-query" } | { type: "scroll-to"; line: number }): void;
  canWrite(): boolean;
  onState(state: TerminalScrollState | null): void;
  /**
   * Whether the view is on screen. Each query runs a plugin on the computer,
   * which repaints the terminal, so a hidden view does not ask.
   */
  shouldPoll?(): boolean;
}) {
  let supported = false;
  let pending = false;
  let sentAt = 0;
  let target: number | null = null;
  let state: TerminalScrollState | null = null;
  let disposed = false;
  let sourceIdentity = {};
  // Answers without a history in a row. Each query repaints every client of
  // the computer's session, so a computer that has no history to report is
  // asked less and less often, up to NATIVE_HISTORY_EMPTY_BACKOFF_MAX_MS.
  let empty = 0;
  let answeredAt = 0;
  const request = () => {
    if (!supported || disposed || (pending && Date.now() - sentAt < NATIVE_HISTORY_RESPONSE_BUDGET_MS)) return;
    if (options.shouldPoll && !options.shouldPoll()) return;
    if (empty > 0 && Date.now() - answeredAt < Math.min(NATIVE_HISTORY_EMPTY_BACKOFF_MAX_MS, NATIVE_HISTORY_POLL_MS * 2 ** (empty - 1))) return;
    if (!options.canWrite()) target = null;
    pending = true; sentAt = Date.now();
    options.send(target === null ? { type: "scroll-query" } : { type: "scroll-to", line: target });
  };
  const timer = setInterval(request, NATIVE_HISTORY_POLL_MS);
  return {
    attach(enabled: boolean) {
      sourceIdentity = {};
      supported = enabled; pending = false; target = null; state = null; empty = 0;
      options.onState(null); request();
    },
    update(next: TerminalScrollState | null) {
      pending = false; state = next;
      answeredAt = Date.now(); empty = next ? 0 : Math.min(empty + 1, 16);
      if (!next || (target !== null && next.above === Math.min(target, next.above + next.below))) target = null;
      options.onState(next);
    },
    getState: () => state,
    getSourceIdentity: () => sourceIdentity,
    scrollTo(line: number) {
      if (!supported || disposed || !options.canWrite() || !state) return false;
      target = Math.max(0, Math.min(100_000, Math.round(line)));
      request();
      return true;
    },
    cancelScroll() { target = null; },
    dispose() { disposed = true; clearInterval(timer); target = null; },
  };
}
