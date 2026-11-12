import { INFERENCE_RESPONSE_CHUNK_MAX_BYTES as MAX } from '@matrix-os/contracts';
import { logPlanFailure, PlanFailure } from './diagnostics';

/** One serialized sender, one <=64KiB pending batch and one <=64KiB source item.
 * Read ahead while the current immutable reply waits for its consumption ACK.
 * This changes batching only: no concurrent POSTs, protocol changes or replay.
 */
export async function* coalesceNativeResponse(
  source: (signal: AbortSignal) => AsyncIterable<string>,
  parent: AbortSignal,
  current: () => boolean,
): AsyncGenerator<string> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const verify = () => {
    signal.throwIfAborted();
    if (!current()) throw new PlanFailure('peer_reply', 'stale_source');
  };
  verify();
  const iterator = source(signal)[Symbol.asyncIterator]();
  let pending = '', bytes = 0, ready = false, ended = false, failed = false;
  let failure: unknown;
  let flush: ReturnType<typeof setTimeout> | undefined;
  let consumer: (() => void) | undefined, producer: (() => void) | undefined;
  let rejectRead: ((error: unknown) => void) | undefined;
  const wakeConsumer = () => { const wake = consumer; consumer = undefined; wake?.(); };
  const wakeProducer = () => { const wake = producer; producer = undefined; wake?.(); };
  const abort = () => { rejectRead?.(signal.reason); wakeConsumer(); wakeProducer(); };
  signal.addEventListener('abort', abort, { once: true });
  const markReady = () => { clearTimeout(flush); flush = undefined; ready = true; wakeConsumer(); };
  const size = (value: string) => {
    const length = Buffer.byteLength(value);
    if (length > MAX) throw new RangeError('Native stream item too large');
    return length;
  };
  const read = () => {
    verify();
    return new Promise<IteratorResult<string>>((resolve, reject) => {
      rejectRead = reject;
      // Observe a late resolution/rejection even if the source ignores abort.
      Promise.resolve().then(() => { verify(); return iterator.next(); }).then(result => {
        rejectRead = undefined;
        try { verify(); resolve(result); } catch (error: unknown) { reject(error); }
      }, (error: unknown) => { rejectRead = undefined; reject(error); });
    });
  };
  const pump = async () => {
    try {
      while (true) {
        while (bytes === MAX) {
          verify(); await new Promise<void>(resolve => { producer = resolve; });
        }
        const next = await read();
        if (next.done) break;
        const length = size(next.value);
        if (!length) continue;
        if (bytes + length > MAX) {
          markReady();
          while (pending) {
            verify(); await new Promise<void>(resolve => { producer = resolve; });
          }
        }
        verify();
        pending += next.value; bytes += length;
        if (bytes === MAX) markReady();
        else if (!ready && flush === undefined) {
          flush = setTimeout(markReady, 50); flush.unref?.();
        }
      }
    } catch (error: unknown) { failed = true; failure = error; }
    finally { ended = true; markReady(); }
  };
  try {
    let first = await read();
    while (!first.done && !size(first.value)) first = await read();
    if (first.done) return;
    // First bytes do not wait for a coalescing timer. Later reads run during ACK.
    void pump(); // All failures are observed and delivered after retained partial bytes.
    yield first.value;
    while (!ended || pending) {
      verify();
      if (!ready && !ended) await new Promise<void>(resolve => { consumer = resolve; });
      verify();
      if (!pending) continue;
      const batch = pending;
      pending = ''; bytes = 0; ready = false; clearTimeout(flush); flush = undefined;
      wakeProducer();
      yield batch;
    }
    verify();
    if (failed) throw failure;
  } finally {
    controller.abort(); clearTimeout(flush); signal.removeEventListener('abort', abort);
    pending = ''; wakeConsumer(); wakeProducer();
    // Stop/409/source changes must not wait for a non-cooperative return().
    try { void iterator.return?.().catch((error: unknown) => logPlanFailure('response_stream_cleanup', error)); }
    catch (error: unknown) { logPlanFailure('response_stream_cleanup', error); }
  }
}
