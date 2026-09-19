import type { TerminalScrollState } from "@matrix-os/contracts";

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
  const request = () => {
    if (!supported || disposed || (pending && Date.now() - sentAt < 4_000)) return;
    if (!options.canWrite()) target = null;
    pending = true; sentAt = Date.now();
    options.send(target === null ? { type: "scroll-query" } : { type: "scroll-to", line: target });
  };
  const timer = setInterval(request, 500);
  return {
    attach(enabled: boolean) {
      supported = enabled; pending = false; target = null; state = null;
      options.onState(null); request();
    },
    update(next: TerminalScrollState | null) {
      pending = false; state = next;
      if (!next || (target !== null && next.above === Math.min(target, next.above + next.below))) target = null;
      options.onState(next);
    },
    getState: () => state,
    scrollTo(line: number) {
      if (!options.canWrite() || !state) return;
      target = Math.max(0, Math.min(100_000, Math.round(line)));
      request();
    },
    dispose() { disposed = true; clearInterval(timer); target = null; },
  };
}
