/** One absolute deadline and the first cancellation cause, including explicit Stop. */
export function createManagedPiRunCancellation(signals: AbortSignal[]) {
  const deadline = new AbortController();
  const timeoutReason = new DOMException("Managed run deadline", "TimeoutError");
  const timer = setTimeout(() => deadline.abort(timeoutReason), 10 * 60_000);
  timer.unref();
  const signal = AbortSignal.any([...signals, deadline.signal]);
  return {
    signal,
    timedOut: () => signal.aborted && signal.reason === timeoutReason,
    dispose: () => clearTimeout(timer),
    /** Settle even if the operation ignores cancellation; dispose resources it acquires late. */
    async wait<T>(operation: () => Promise<T>, discard?: (value: T) => void | Promise<void>): Promise<T> {
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        let pending: Promise<T>;
        try { pending = operation(); }
        catch (error: unknown) { signal.removeEventListener("abort", abort); reject(error); return; }
        void pending.then(value => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) { resolve(value); return; }
          if (discard) void Promise.resolve().then(() => discard(value)).catch((error: unknown) => console.warn("[managed-pi] late resource cleanup failed", error instanceof Error ? "Error" : "UnknownError"));
          reject(signal.reason);
        }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
      });
    },
  };
}

/** A pending cleanup is not proof of release. Keep its rejection handled after the wait ends. */
export async function awaitManagedPiCleanup(operation: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation().catch((error: unknown) => console.warn("[managed-pi] cleanup failed", error instanceof Error ? "Error" : "UnknownError")),
      new Promise<void>(resolve => {
        timer = setTimeout(() => { console.warn("[managed-pi] cleanup still pending"); resolve(); }, 10_000);
        timer.unref();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
