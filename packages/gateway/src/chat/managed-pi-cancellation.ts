/** First cancellation cause, including explicit Stop. Busy work has no total run deadline. */
export function createManagedPiRunCancellation(signals: AbortSignal[]) {
  const signal = AbortSignal.any(signals);
  const SETUP_STEP_TIMEOUT_MS = 60_000;
  function waitFor<T>(operation: () => Promise<T>, discard: ((value: T) => void | Promise<void>) | undefined, timeoutMs?: number): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
        if (result.ok) resolve(result.value);
        else reject(result.error);
        return true;
      };
      const abort = () => { finish({ ok: false, error: signal.reason }); };
      signal.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => { finish({ ok: false, error: new DOMException("Managed setup step timed out", "TimeoutError") }); }, timeoutMs);
        timer.unref?.();
      }
      let pending: Promise<T>;
      try { pending = operation(); }
      catch (error: unknown) { finish({ ok: false, error }); return; }
      void pending.then(value => {
        if (finish({ ok: true, value })) return;
        if (discard) void Promise.resolve().then(() => discard(value)).catch((error: unknown) => console.warn("[managed-pi] late resource cleanup failed", error instanceof Error ? "Error" : "UnknownError"));
      }, (error: unknown) => { finish({ ok: false, error }); });
    });
  }
  return {
    signal,
    /** Each setup step is bounded independently; the worker's busy turn is not. */
    async wait<T>(operation: () => Promise<T>, discard?: (value: T) => void | Promise<void>): Promise<T> {
      return waitFor(operation, discard, SETUP_STEP_TIMEOUT_MS);
    },
    /** The active worker is governed by a renewable runtime lease, not a wall-clock run timer. */
    waitBusy<T>(operation: () => Promise<T>): Promise<T> {
      return waitFor(operation, undefined);
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
