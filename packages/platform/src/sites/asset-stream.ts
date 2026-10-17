import { Readable } from 'node:stream';
import { SiteError } from './types.js';

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const ASSET_DEADLINE_MS = 30_000;

function logCleanup(error: unknown) {
  console.warn('[sites] asset stream cleanup failed', error instanceof Error ? error.name : 'UnknownError');
}

// Cancellation callbacks may themselves stall. Initiate cleanup without extending
// the request deadline; Node destruction also closes an unfinished SDK response.
function discard(body: unknown, reader?: ReadableStreamDefaultReader<Uint8Array>) {
  if (reader) void reader.cancel().catch(logCleanup);
  else if (body instanceof ReadableStream) void body.cancel().catch(logCleanup);
  if (body instanceof Readable) body.destroy();
}

/** One absolute deadline covers both storage headers and every body read. */
export async function loadSiteAsset(
  acquire: (signal: AbortSignal) => Promise<{ body: unknown }>,
  expectedBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_ASSET_BYTES)
    throw new SiteError('unavailable');
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const abort = () => deadline.reject(new SiteError('unavailable'));
  controller.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), ASSET_DEADLINE_MS);
  timer.unref?.();
  let body: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    // Even an adapter that ignores the signal must not keep this request alive.
    // Its eventual response is disposed rather than leaking a late HTTP body.
    const acquisition = acquire(controller.signal).then(object => {
      if (controller.signal.aborted) {
        discard(object.body);
        throw new SiteError('unavailable');
      }
      return object;
    });
    const object = await Promise.race([acquisition, deadline.promise]);
    body = object.body;
    if (!body) throw new SiteError('not_found');
    const stream = body instanceof Readable
      ? Readable.toWeb(body, { strategy: { highWaterMark: 64 * 1024,
          size: chunk => chunk instanceof Uint8Array ? chunk.byteLength : 64 * 1024 } })
      : body;
    if (!(stream instanceof ReadableStream)) throw new SiteError('unavailable');
    reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline.promise]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new SiteError('unavailable');
      size += part.value.byteLength;
      if (size > expectedBytes || size > MAX_ASSET_BYTES) throw new SiteError('unavailable');
      chunks.push(part.value);
    }
    if (size !== expectedBytes) throw new SiteError('unavailable');
    complete = true;
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof SiteError) throw error;
    console.warn('[sites] asset stream failed', error instanceof Error ? error.name : 'UnknownError');
    throw new SiteError('unavailable');
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    if (!complete) discard(body, reader);
    reader?.releaseLock();
  }
}
