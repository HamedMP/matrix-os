import { INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES } from '@matrix-os/contracts';
import { ScopeRuntimeInferenceStreamFrameSchema, type ScopeRuntimeInferenceStreamResponse } from '@matrix-os/scope-runtime/broker-protocol';
import type { Socket } from 'node:net';

export function isInferenceStream(value: Record<string, unknown>): value is ScopeRuntimeInferenceStreamResponse {
  const body = value.body;
  return value.ok === true && body !== null && typeof body === 'object' && Symbol.asyncIterator in body;
}

/** Cancellation also bounds a provider iterator that ignores its own signal. */
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One bounded frame is written at a time. Slow readers stop upstream pulls. */
export async function writeInferenceStream(socket: Socket, response: ScopeRuntimeInferenceStreamResponse, signal: AbortSignal): Promise<void> {
  const write = async (raw: unknown) => {
    signal.throwIfAborted();
    const frame = JSON.stringify(ScopeRuntimeInferenceStreamFrameSchema.parse(raw)) + '\n';
    if (Buffer.byteLength(frame) > INFERENCE_RESPONSE_STREAM_FRAME_MAX_BYTES) throw new RangeError('response_too_large');
    if (!socket.write(frame)) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off('drain', drain); socket.off('close', close); socket.off('error', fail); signal.removeEventListener('abort', abort); };
      const drain = () => { cleanup(); resolve(); };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const close = () => fail(new Error('Inference transport closed'));
      const abort = () => fail(signal.reason);
      socket.once('drain', drain); socket.once('close', close); socket.once('error', fail); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const base = { version: 1, requestId: response.requestId };
  const iterator = response.body[Symbol.asyncIterator]();
  let completed = false;
  try {
    await write({ ...base, stream: 'start', status: response.status, headers: response.headers });
    let sequence = 0;
    while (true) {
      const next = await cancellable(iterator.next(), signal);
      if (next.done) break;
      if (sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Inference sequence exhausted');
      await write({ ...base, stream: 'chunk', sequence: sequence++, body: next.value });
    }
    await write({ ...base, stream: 'end', sequence });
    completed = true;
    socket.end();
  } finally {
    if (!completed) {
      socket.destroy();
      // Do not let an uncooperative upstream hold the broker shutdown open.
      try { void iterator.return?.().catch((error: unknown) => console.warn('[scope-runtime] stream cleanup failed:', error instanceof Error ? error.name : 'UnknownError')); }
      catch (error: unknown) { console.warn('[scope-runtime] stream cleanup failed:', error instanceof Error ? error.name : 'UnknownError'); }
    }
  }
}
