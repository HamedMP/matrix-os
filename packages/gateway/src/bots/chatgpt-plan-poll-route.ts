import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { boundedOperation } from '../bounded-operation.js';
import type { PeerPollEmission } from './chatgpt-plan-poll-delivery.js';

/** Tiny ACK/control DTOs: never buffer an untrusted JSON body before its cap. */
export async function readPeerControlBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing JSON');
  const cancel = () => { void reader.cancel().catch((error: unknown) => {
    console.warn('[chatgpt-plan] Control body cleanup:', error instanceof Error ? error.name : 'UnknownError');
  }); };
  try {
    return await boundedOperation(async signal => {
      signal.addEventListener('abort', cancel, { once: true });
      const parts: Uint8Array[] = []; // <=512 nonempty one-byte parts.
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) return JSON.parse(Buffer.concat(parts, bytes).toString('utf8')) as unknown;
          bytes += part.value.byteLength;
          if (bytes > 512) throw new HTTPException(413);
          if (part.value.byteLength) parts.push(part.value);
        }
      } finally { signal.removeEventListener('abort', cancel); }
    }, 10000, request.signal);
  } finally { cancel(); }
}

/** Emission completion releases only this response, never the receipt ledger. */
export function emitPeerPoll(c: Context, emission: PeerPollEmission) {
  c.header('Content-Type', 'application/json');
  return stream(c, async output => {
    const abort = () => output.abort();
    const timer = setTimeout(abort, Math.max(0, emission.remainingMs()));
    timer.unref?.();
    emission.signal.addEventListener('abort', abort, { once: true });
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    try {
      if (emission.remainingMs() <= 0) { output.abort(); return; }
      for (let offset = 0; offset < emission.encoded.byteLength; offset += 65536) {
        if (output.aborted || emission.signal.aborted || c.req.raw.signal.aborted) return;
        emission.verify();
        // A queued view would retain the entire encoding after this slot releases.
        await output.write(emission.encoded.slice(offset, offset + 65536));
      }
    } catch (error: unknown) {
      if (!output.aborted) console.warn('[chatgpt-plan] Poll emission unavailable:', error instanceof Error ? error.name : 'UnknownError');
      output.abort();
    } finally {
      clearTimeout(timer);
      emission.signal.removeEventListener('abort', abort);
      c.req.raw.signal.removeEventListener('abort', abort);
      emission.release();
    }
  });
}
