import type { JevEvaluationRepository } from "./repository.js";

const RESULT_CLEANUP_INTERVAL_MS = 60_000;

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
    async close() {
      if (!closed) {
        closed = true;
        cancel(handle);
      }
      await inFlight;
    },
  };
}
