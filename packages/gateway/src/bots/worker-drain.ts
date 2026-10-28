/** Retain final checkpoint authority briefly after cancelling inference, never new work. */
export function createBotWorkerDrain(options: {
  release(): Promise<void>;
  onError(error: unknown): void;
  graceMs?: number;
}) {
  const transport = new AbortController();
  let pending = false, stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releasing: Promise<void> | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  function release(): Promise<void> {
    if (releasing) return releasing;
    if (timer) clearTimeout(timer);
    timer = undefined;
    transport.abort();
    let cleanupTimer: ReturnType<typeof setTimeout>;
    releasing = new Promise<void>((resolve, reject) => {
      cleanupTimer = setTimeout(() => reject(new DOMException("Runtime cleanup timed out", "TimeoutError")), 10_000);
      cleanupTimer.unref?.();
      Promise.resolve().then(options.release).then(resolve, reject);
    }).finally(() => clearTimeout(cleanupTimer));
    // done is a cleanup receipt, including failed release; callers retain the real error.
    void releasing.then(finish, finish);
    return releasing;
  }
  const releaseInBackground = () => { void release().catch(options.onError); };
  return {
    signal: transport.signal, done, release,
    track<T>(work: Promise<T>): Promise<T> {
      pending = true;
      return work.then(value => {
        pending = false;
        if (stopping) releaseInBackground();
        return value;
      }, (error: unknown) => {
        pending = false;
        // A lost command socket is not evidence that the worker saved its session.
        throw error;
      });
    },
    stop(): void {
      if (stopping || releasing) return;
      stopping = true;
      if (!pending) { releaseInBackground(); return; }
      // At most one clock per bound runtime (registry cap64), always <=10s.
      const graceMs = Math.max(1, Math.min(Math.trunc(options.graceMs ?? 10_000), 10_000));
      timer = setTimeout(releaseInBackground, graceMs);
      timer.unref?.();
    },
  };
}
