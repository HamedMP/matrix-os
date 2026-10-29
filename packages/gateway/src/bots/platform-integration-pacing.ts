/** Stay below the platform's existing per-handle refill rate. No retries,
 * cached authority, new permissions or server-limit changes are involved. */
const SPACING_MS = 600;
const MAX_OUTSTANDING = 16;
const unavailable = () => new Error('Integration request unavailable');

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(unavailable()); };
    signal.addEventListener('abort', stop, { once: true });
    // Always observe work, including when the caller has already aborted.
    work.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
    if (signal.aborted) stop();
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(unavailable()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    timer.unref?.();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

export function createPlatformIntegrationPacer() {
  let tail: Promise<void> = Promise.resolve();
  let outstanding = 0;
  let lastStart: number | undefined;
  return async (signal: AbortSignal, send: () => Promise<Response>): Promise<Response> => {
    if (signal.aborted || outstanding >= MAX_OUTSTANDING) throw unavailable();
    outstanding++;
    const work = tail.then(async () => {
      if (signal.aborted) throw unavailable();
      // Use actual start time rather than reserved timer slots: an event-loop
      // stall must not release several overdue requests as another burst.
      while (lastStart !== undefined && performance.now() - lastStart < SPACING_MS) {
        await delay(SPACING_MS - (performance.now() - lastStart), signal);
      }
      if (signal.aborted) throw unavailable();
      lastStart = performance.now();
      return send();
    }).finally(() => { outstanding--; });
    // Cancellation rejects the caller promptly, but its queued slot settles in
    // order. Releasing it early could let a later request pass an active one.
    tail = work.then(() => undefined, () => undefined);
    return abortable(work, signal);
  };
}
