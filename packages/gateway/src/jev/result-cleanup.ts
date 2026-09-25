import type { JevEvaluationRepository } from "./repository.js";

const RESULT_CLEANUP_INTERVAL_MS = 60_000;
const RESULT_CLEANUP_SHUTDOWN_GRACE_MS = 5_000;

export function startJevResultCleanup(options: {
  repository: Pick<JevEvaluationRepository, "pruneExpiredCompletedResults">;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}): { runNow: () => Promise<void>; close: () => Promise<void> } {
  const schedule = options.schedule ?? ((callback, ms) => setInterval(callback, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const onError = options.onError ?? ((error: unknown) => {
    console.error("[jev] Result cleanup failed:", error instanceof Error ? error.name : "UnknownError");
  });
  let closed = false;
  let inFlight: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;

  const runNow = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = options.repository.pruneExpiredCompletedResults()
      .catch((error: unknown) => { onError(error); })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const handle = schedule(() => { void runNow(); }, RESULT_CLEANUP_INTERVAL_MS);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    const unref = (handle as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(handle);
  }
  void runNow();

  return {
    runNow,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      cancel(handle);
      const active = inFlight;
      if (!active) return (closePromise = Promise.resolve());

      // A pool acquisition or query can outlive shutdown. Stop future ticks,
      // then give the current sweep a bounded grace before releasing Gateway
      // shutdown to the owner of the shared database connection.
      closePromise = new Promise<void>((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (timeout) clearTimeout(timeout);
          resolve();
        };
        timeout = setTimeout(() => {
          console.error("[jev] Result cleanup still in flight after shutdown grace");
          finish();
        }, RESULT_CLEANUP_SHUTDOWN_GRACE_MS);
        timeout.unref?.();
        void active.then(finish, finish);
      });
      return closePromise;
    },
  };
}
