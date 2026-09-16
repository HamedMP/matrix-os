/** Bounds the local wait even when a dependency ignores cancellation. */
export async function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new Error("Operation interrupted or timed out"));
        };
        timer = setTimeout(onAbort, timeoutMs);
        timer.unref?.();
        parent?.addEventListener("abort", onAbort, { once: true });
        if (parent?.aborted) onAbort();
      }),
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) parent?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
