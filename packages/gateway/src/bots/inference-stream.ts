import { INFERENCE_RESPONSE_BUFFER_MAX_BYTES, INFERENCE_RESPONSE_CHUNK_MAX_BYTES } from '@matrix-os/contracts';

/** Bounds one transport chunk, independently of the lifetime output volume. */
export function* inferenceChunks(text: string): Generator<string> {
  let part = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > INFERENCE_RESPONSE_CHUNK_MAX_BYTES) { yield part; part = ''; bytes = 0; }
    part += character; bytes += size;
  }
  if (part) yield part;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('Inference cancelled')); };
    const finish = () => signal.removeEventListener('abort', aborted);
    pending.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Own the reader so cancellation also tears down a stalled upstream body. */
export async function* inferenceResponseText(response: Response, signal: AbortSignal, idleTimeoutMs?: number): AsyncGenerator<string> {
  if (!response.body) throw new Error('Inference body unavailable');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  const idle = idleTimeoutMs === undefined ? undefined : { controller: new AbortController(), remaining: idleTimeoutMs };
  const readSignal = idle ? AbortSignal.any([signal, idle.controller.signal]) : signal;
  try {
    while (true) {
      // Only upstream wait time counts: downstream backpressure is not provider idleness.
      const started = performance.now();
      const timer = idle ? setTimeout(() => idle.controller.abort(new DOMException('Inference body idle', 'TimeoutError')), idle.remaining) : undefined;
      timer?.unref?.();
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await abortable(reader.read(), readSignal); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        if (idle) idle.remaining = Math.max(0, idle.remaining - (performance.now() - started));
      }
      if (next.done) break;
      // Empty reads are not progress and cannot renew a stalled body's deadline.
      if (idle && next.value.byteLength > 0) idle.remaining = idleTimeoutMs!;
      // A fetch read can contain many events. Decode bounded byte slices.
      for (let offset = 0; offset < next.value.length; offset += INFERENCE_RESPONSE_CHUNK_MAX_BYTES) {
        const text = decoder.decode(next.value.subarray(offset, offset + INFERENCE_RESPONSE_CHUNK_MAX_BYTES), { stream: true });
        if (text) yield text;
      }
    }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally {
    void reader.cancel().catch(error => console.warn('[bots] inference body cancellation failed:', error instanceof Error ? error.name : 'UnknownError'));
    reader.releaseLock();
  }
}

/** Await at most one source chunk; downstream pull provides backpressure. */
export async function* guardInferenceStream(source: AsyncIterable<string>, options: {
  signal: AbortSignal; authorized(): Promise<boolean>; abort(): void;
}): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      options.signal.throwIfAborted();
      const next = await abortable(iterator.next(), options.signal);
      if (!await options.authorized()) throw new Error('Inference authority unavailable');
      options.signal.throwIfAborted();
      if (next.done) return;
      for (const chunk of inferenceChunks(next.value)) {
        options.signal.throwIfAborted(); yield chunk;
      }
    }
  } finally {
    options.abort();
    // A non-cooperative source must not keep Stop waiting for its return().
    void iterator.return?.().catch(error => console.warn('[bots] inference stream cancellation failed:', error instanceof Error ? error.name : 'UnknownError'));
  }
}

/** Buffer only a single complete SSE event; total stream volume is unbounded.
 * A reserved terminal frame shares the same parser-memory allowance. */
export async function* boundedInferenceSseFrames(source: AsyncIterable<string>, reservedBytes: () => number = () => 0): AsyncGenerator<string> {
  let pending = '', previousCR = false;
  for await (const transport of source) {
    for (const piece of inferenceChunks(transport)) {
      let normalized = '';
      for (const character of piece) {
        if (previousCR) { previousCR = false; if (character === '\n') continue; }
        if (character === '\r') { normalized += '\n'; previousCR = true; }
        else normalized += character;
      }
      pending += normalized;
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end + 2); pending = pending.slice(end + 2);
        if (Buffer.byteLength(frame) + reservedBytes() > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) throw new RangeError('response_too_large');
        yield frame;
      }
      if (Buffer.byteLength(pending) + reservedBytes() > INFERENCE_RESPONSE_BUFFER_MAX_BYTES) throw new RangeError('response_too_large');
    }
  }
  // Empty trailing line breaks have no event payload. Any partial field does.
  if (/[^\n]/.test(pending)) throw new Error('Incomplete inference event');
}

/** Do not expose a completion or [DONE] until the actual EOF and final authority check. */
export async function* validateChatGptStream(source: AsyncIterable<string>, modelId: string, authorized: () => Promise<boolean>): AsyncGenerator<string> {
  let held = '', completed = false, done = false;
  for await (const frame of boundedInferenceSseFrames(source, () => Buffer.byteLength(held))) {
    const lines = frame.slice(0, -2).split('\n').filter(Boolean);
    if (lines.some(line => !line.startsWith(':') && !/^(?:data|event|id|retry)(?::|$)/.test(line))) throw new Error('Invalid inference stream');
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data === '[DONE]') {
      if (!completed || done) throw new Error('Invalid inference completion');
      done = true;
    } else if (data) {
      const event: unknown = JSON.parse(data);
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string'
        || !/^(?:response\.[a-z0-9_.]+|error)$/.test(event.type) || event.type.length > 128) throw new Error('Invalid inference event');
      if (completed || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('Incomplete inference stream');
      if (lines.filter(line => line.startsWith('event:')).some(line => { const name = line.slice(6).trim(); return name && name !== event.type; })) throw new Error('Invalid inference event');
      if (event.type === 'response.output_text.delta' && (!('delta' in event) || typeof event.delta !== 'string')) throw new Error('Invalid inference delta');
      if (event.type === 'response.completed') {
        const response = 'response' in event ? event.response : undefined;
        if (!response || typeof response !== 'object' || !('status' in response) || response.status !== 'completed'
          || !('model' in response) || response.model !== modelId) throw new Error('Invalid inference completion');
        completed = true;
      }
    }
    if (completed) held += frame;
    else yield* inferenceChunks(frame);
  }
  if (!completed || !await authorized()) throw new Error('Incomplete inference stream');
  yield* inferenceChunks(held);
}
