/** Shared app-AI lifetime. Entries survive caller cancellation until actual work
 * settles; admission is bounded and shutdown never clears undrained entries. */
export function createAppAiLifecycle() {
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  const limit = 16;
  let closing: Promise<void> | undefined;
  function track<T>(operation: () => Promise<T>): Promise<T> {
    if (shutdown.signal.aborted || active.size >= limit) return Promise.reject(new Error('App AI is unavailable'));
    const pending = Promise.resolve().then(() => { shutdown.signal.throwIfAborted(); return operation(); }).finally(() => { active.delete(pending); });
    active.add(pending);
    return pending;
  }
  return {
    signal: shutdown.signal,
    track,
    close(): Promise<void> {
      if (closing) return closing;
      shutdown.abort(new Error('App AI is shutting down'));
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...active]),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('App AI shutdown drain unavailable')), 5000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      })();
      return closing;
    },
  };
}
