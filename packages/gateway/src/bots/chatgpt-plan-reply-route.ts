import { CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT } from '@matrix-os/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { stream } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { ChatGptPlanPeerError } from './chatgpt-plan-peer-error.js';

/** One owner-Host router, <=8 input/emission slots, <=2 waiters per stream. */
export function createPeerReplyIngress() {
  type Lease = ReturnType<typeof reserve>;
  const active = new Set<{ expires: number; expire(): void }>(); // <=8; fixed 10s deadline + shutdown of each request.
  const waiters = new Map<string, number>(); // <=8; released on ACK/error/abort/deadline.
  const unavailable = () => new ChatGptPlanPeerError('unavailable');
  const key = 'chatGptPlanReplyEmission';
  function reserve(c: Context) {
    for (const lease of active) if (lease.expires <= performance.now()) lease.expire();
    if (active.size >= 8) throw unavailable();
    const controller = new AbortController();
    let handedOff = false, released = false, oversized = false;
    let cleanupBody = () => {};
    const expire = () => { controller.abort(); };
    const lease = { expires: performance.now() + 10000, expire };
    const timer = setTimeout(expire, 10000); timer.unref?.();
    const parent = c.req.raw.signal;
    parent.addEventListener('abort', expire, { once: true });
    active.add(lease);
    if (parent.aborted) expire();
    const release = () => {
      if (released) return;
      released = true; clearTimeout(timer); parent.removeEventListener('abort', expire);
      cleanupBody(); active.delete(lease);
    };
    // Bound actual bytes even with a misleading Content-Length, before Hono's
    // bodyLimit eagerly drains chunked input. The deadline also cancels slow input.
    try {
      const reader = c.req.raw.body?.getReader();
      if (reader) {
        let bytes = 0, done = false;
        const cancel = () => { if (!done) { done = true; void reader.cancel().catch((error: unknown) => {
          console.warn('[chatgpt-plan] Reply input cleanup:', error instanceof Error ? error.name : 'UnknownError');
        }); } };
        let failBody = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(output) {
            failBody = () => { if (!done) output.error(unavailable()); cancel(); };
            controller.signal.addEventListener('abort', failBody, { once: true });
            if (controller.signal.aborted) failBody();
          },
          async pull(output) {
            try {
              controller.signal.throwIfAborted();
              const part = await reader.read();
              controller.signal.throwIfAborted();
              if (part.done) { done = true; output.close(); return; }
              bytes += part.value.byteLength;
              if (bytes > CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT) { oversized = true; output.error(new HTTPException(413)); cancel(); return; }
              output.enqueue(part.value);
            } catch (error: unknown) { if (!done) { output.error(error); cancel(); } }
          },
          cancel,
        }, { highWaterMark: 0 });
        cleanupBody = () => { controller.signal.removeEventListener('abort', failBody); cancel(); };
        c.req.raw = new Request(c.req.raw, { body, duplex: 'half' } as RequestInit);
      }
    } catch (error: unknown) { release(); throw error; }
    const verify = () => {
      if (oversized) throw new HTTPException(413);
      if (performance.now() >= lease.expires) expire();
      if (controller.signal.aborted) throw unavailable();
    };
    return { signal: controller.signal, release, verify, get oversized() { return oversized; },
      get handedOff() { return handedOff; }, handOff() { handedOff = true; } };
  }
  const guard = (authorize: (c: Context) => unknown): MiddlewareHandler => async (c, next) => {
    authorize(c); // Authorization precedes both admission and any body read.
    const lease = reserve(c); c.set(key, lease);
    try { await next(); } finally { if (!lease.handedOff) lease.release(); }
  };
  const wait = async <T>(c: Context, sessionId: string, id: string, operation: () => T | Promise<T>) => {
    const lease = c.get(key) as Lease;
    const identity = `${sessionId}/${id}`;
    const count = waiters.get(identity) ?? 0;
    if (count >= 2) throw unavailable();
    waiters.set(identity, count + 1);
    let abort!: () => void;
    try {
      lease.verify();
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(unavailable()); lease.signal.addEventListener('abort', abort, { once: true });
      });
      const ack = await Promise.race([Promise.resolve(operation()), interrupted]);
      lease.verify(); return ack;
    } finally {
      if (abort) lease.signal.removeEventListener('abort', abort);
      const remaining = (waiters.get(identity) ?? 1) - 1;
      if (remaining) waiters.set(identity, remaining); else waiters.delete(identity);
    }
  };
  const emit = (c: Context, ack: unknown) => {
    const lease = c.get(key) as Lease;
    lease.verify();
    const encoded = new TextEncoder().encode(JSON.stringify(ack));
    c.header('Content-Type', 'application/json'); lease.handOff();
    return stream(c, async output => {
      const abort = () => output.abort();
      lease.signal.addEventListener('abort', abort, { once: true });
      try { if (lease.signal.aborted) output.abort(); else await output.write(encoded); }
      catch (error: unknown) {
        if (!output.aborted) console.warn('[chatgpt-plan] Reply emission unavailable:', error instanceof Error ? error.name : 'UnknownError');
        output.abort();
      } finally { lease.signal.removeEventListener('abort', abort); lease.release(); }
    });
  };
  const interrupted = (c: Context) => Boolean((c.get(key) as Lease | undefined)?.signal.aborted);
  const oversized = (c: Context) => Boolean((c.get(key) as Lease | undefined)?.oversized);
  const signal = (c: Context) => (c.get(key) as Lease).signal;
  return { guard, wait, emit, interrupted, oversized, signal };
}
