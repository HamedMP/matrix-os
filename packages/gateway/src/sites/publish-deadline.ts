import { SITE_PUBLISH_TIMEOUT_MS } from '@matrix-os/contracts';

class PublicationExpired extends Error {
  constructor() { super('Publication unavailable'); this.name = 'PublicationExpired'; }
}
/** Includes time queued behind other app builds. A timed-out HTTP request must
 * not release the real build lock or its resource admission while work runs. */
export function createPublicationDeadline(caller: AbortSignal) {
  const expiresAt = Date.now() + SITE_PUBLISH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_PUBLISH_TIMEOUT_MS);
  timer.unref();
  const signal = AbortSignal.any([caller, controller.signal]);
  function check() {
    if (signal.aborted || Date.now() >= expiresAt) throw new PublicationExpired();
  }
  return {
    signal, check, deadlineAt: expiresAt,
    dispose() { clearTimeout(timer); },
    async wait<T>(work: Promise<T>): Promise<T> {
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(new PublicationExpired());
      signal.addEventListener('abort', onAbort, { once: true });
      try { check(); const result = await Promise.race([work, aborted.promise]); check(); return result; }
      finally { signal.removeEventListener('abort', onAbort); }
    },
  };
}
