/** Bounds awaits even when a dependency does not itself implement AbortSignal. */
export async function awaitMirrorOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  // Observe even an already-started dependency when the deadline preceded this await.
  if (signal.aborted) return Promise.race([Promise.reject(signal.reason), operation]);
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}
