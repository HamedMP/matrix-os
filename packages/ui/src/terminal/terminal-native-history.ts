import type { TerminalScrollState } from "@matrix-os/contracts";

export const NATIVE_HISTORY_RESPONSE_BUDGET_MS = 4_000;

/** Bounded, coalescing transport for the single rail of an attached terminal. */
export function createTerminalNativeHistory(options: {
  send(frame: { type: "scroll-query" } | { type: "scroll-to"; line: number }): void;
  canWrite(): boolean;
  onState(state: TerminalScrollState | null): void;
}) {
  let supported = false;
  let pending = false;
  let sentAt = 0;
  let target: number | null = null;
  let state: TerminalScrollState | null = null;
  let disposed = false;
  let sourceIdentity = {};
  const request = () => {
    if (!supported || disposed || (pending && Date.now() - sentAt < NATIVE_HISTORY_RESPONSE_BUDGET_MS)) return;
    if (!options.canWrite()) target = null;
    pending = true; sentAt = Date.now();
    options.send(target === null ? { type: "scroll-query" } : { type: "scroll-to", line: target });
  };
  const timer = setInterval(request, 500);
  return {
    attach(enabled: boolean) {
      sourceIdentity = {};
      supported = enabled; pending = false; target = null; state = null;
      options.onState(null); request();
    },
    update(next: TerminalScrollState | null) {
      pending = false; state = next;
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
