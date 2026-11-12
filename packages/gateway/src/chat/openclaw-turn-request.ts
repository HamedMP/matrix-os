import type { OpenClawRpcClient, OpenClawRpcEvent } from "../agent-config/openclaw-rpc.js";

/** Each exchange is bounded; waiting again observes the same run and never resubmits work. */
export async function requestOpenClawTurn(options: {
  rpc: OpenClawRpcClient;
  params: Record<string, unknown>;
  signal: AbortSignal;
  requestTimeoutMs: number;
  accept(value: unknown): string | undefined;
  onDispatched?(): void;
  onEvent?: (event: OpenClawRpcEvent) => void;
}): Promise<unknown> {
  let acceptedRunId: string | undefined;
  const accept = (value: unknown) => { acceptedRunId = options.accept(value); return acceptedRunId; };
  async function exchange(method: string, params: unknown, timeoutMs: number) {
    options.signal.throwIfAborted();
    const deadline = new AbortController();
    const signal = AbortSignal.any([options.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    timer.unref?.();
    let abort: () => void = () => undefined;
    try {
      return await Promise.race([
        options.rpc.call(method, params, signal, {
          timeoutMs,
          ...(method === "agent" ? { onAccepted: accept, onDispatched: options.onDispatched } : {}),
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  const initial = await exchange("agent", options.params, options.requestTimeoutMs);
  if (typeof initial !== "object" || initial === null || !("status" in initial) || initial.status !== "accepted") return initial;
  const runId = acceptedRunId ?? accept(initial);
  if (!runId) throw new Error("Invalid agent acceptance");
  const waitMs = Math.min(options.requestTimeoutMs, 295_000);
  while (!options.signal.aborted) {
    const startedAt = Date.now();
    const result = await exchange("agent.wait", { runId, timeoutMs: waitMs }, waitMs + 5_000);
    if (typeof result !== "object" || result === null || !("status" in result)) throw new Error("Invalid agent wait result");
    if ("runId" in result && result.runId !== runId) throw new Error("Mismatched agent wait result");
    if (result.status !== "timeout" && result.status !== "pending") return result;
    // A draining/queued server can respond immediately. Avoid a tight retry loop.
    const delayMs = 100 - (Date.now() - startedAt);
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
        const timer = setTimeout(() => { options.signal.removeEventListener("abort", abort); resolve(); }, delayMs);
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }
  }
  throw options.signal.reason;
}
