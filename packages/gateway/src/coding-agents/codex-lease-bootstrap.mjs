import { timingSafeEqual } from "node:crypto";

function deferred() {
  let resolve;
  const promise = new Promise((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
}

async function bounded(promise, signal, message) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error(message));
    const timer = setTimeout(abort, 30_000);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(undefined, value));
    if (signal?.aborted) abort();
  });
}

/** Bind/readiness acknowledgements precede the separate inference release. */
export function createCodexLeaseBootstrap(attemptId, schema, message) {
  const initial = deferred(),
    ready = deferred(),
    released = deferred();
  let lease,
    healthy = false,
    failed = false;
  return {
    async bind(raw) {
      const parsed = schema.safeParse(raw);
      if (!attemptId || failed || !parsed.success || parsed.data.attemptId !== attemptId) return false;
      if (
        lease &&
        (lease.gatewayPort !== parsed.data.gatewayPort ||
          !timingSafeEqual(Buffer.from(lease.token), Buffer.from(parsed.data.token)))
      )
        return false;
      lease = parsed.data;
      initial.resolve(lease);
      return (await bounded(ready.promise, undefined, message)) === true;
    },
    async waitLease(signal) {
      if (failed) throw new Error(message);
      if (!attemptId) return undefined;
      const value = await bounded(initial.promise, signal, message);
      if (!value) throw new Error(message);
      return value;
    },
    markReady() {
      if (!failed && lease) {
        healthy = true;
        ready.resolve(true);
      }
    },
    release(id) {
      if (!healthy || failed || id !== attemptId) return false;
      released.resolve(true);
      return true;
    },
    async waitRelease(signal) {
      if (attemptId && (await bounded(released.promise, signal, message)) !== true) throw new Error(message);
    },
    fail() {
      failed = true;
      healthy = false;
      initial.resolve(undefined);
      ready.resolve(false);
      released.resolve(false);
    },
  };
}
