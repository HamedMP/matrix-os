/** A bot's individual preparation call may wait for I/O, but worker execution has no wall-clock limit. */
export const BOT_SETUP_STEP_TIMEOUT_MS = 60_000;

export class BotSetupStepError extends Error {
  constructor(readonly code: "timeout" | "aborted") {
    super(`Bot setup ${code}`);
    this.name = "BotSetupStepError";
  }
}

/**
 * Settle promptly on Stop or a stalled setup call. An operation that ignores
 * cancellation can still resolve later, so hand its late resource to its
 * owner for cleanup without re-entering the run.
 */
export function runBotSetupStep<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateSuccess?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new BotSetupStepError("aborted"));
  return new Promise<T>((resolve, reject) => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      active = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (!active) return;
      cleanup();
      reject(new BotSetupStepError("aborted"));
    };
    timer = setTimeout(() => {
      if (!active) return;
      cleanup();
      reject(new BotSetupStepError("timeout"));
    }, BOT_SETUP_STEP_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    // An abort can arrive between the initial check and listener registration.
    if (signal.aborted) { onAbort(); return; }
    void Promise.resolve().then(() => {
      if (!active) throw new BotSetupStepError("aborted");
      return operation();
    }).then((value) => {
      if (!active) {
        try {
          void Promise.resolve(onLateSuccess?.(value)).catch((error: unknown) => {
            console.warn("[bots] late setup cleanup failed:", error instanceof Error ? error.name : "UnknownError");
          });
        } catch (error: unknown) {
          console.warn("[bots] late setup cleanup failed:", error instanceof Error ? error.name : "UnknownError");
        }
        return;
      }
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (!active) return;
      cleanup();
      reject(error);
    });
  });
}
