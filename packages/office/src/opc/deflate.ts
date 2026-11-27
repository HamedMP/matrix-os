/**
 * Raw DEFLATE through the platform CompressionStream / DecompressionStream.
 *
 * Inflation is bounded: the caller states the largest output it will accept and
 * the stream is cancelled as soon as one more byte arrives, so a hostile entry
 * cannot grow memory past that bound plus one stream chunk.
 */

/** Compressed input is fed in slices this small so one write cannot expand without a check. */
const INPUT_SLICE = 16 * 1024;

export type InflateFailureKind = "too-large" | "corrupt" | "unsupported";

/** Internal signal; the ZIP layer maps it to the public typed error. */
export class InflateFailure extends Error {
  readonly kind: InflateFailureKind;

  constructor(kind: InflateFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InflateFailure";
    this.kind = kind;
  }
}

interface ByteTransform {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

type ByteTransformConstructor = new (format: "deflate-raw") => ByteTransform;

function platformStream(name: "CompressionStream" | "DecompressionStream"): ByteTransform {
  const ctor = (globalThis as unknown as Record<string, ByteTransformConstructor | undefined>)[name];
  if (typeof ctor !== "function") {
    throw new InflateFailure("unsupported", `${name} is not available on this platform`);
  }
  try {
    return new ctor("deflate-raw");
  } catch (error) {
    // An engine that has the constructor but not the format throws a TypeError (or a RangeError in older ones).
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new InflateFailure("unsupported", `${name} does not support deflate-raw on this platform`, error);
    }
    throw error;
  }
}

interface PumpState {
  error: unknown;
  failed: boolean;
}

/** Feeds `data` into the writable side in small slices and records, never throws, a failure. */
function pump(writable: WritableStream<Uint8Array>, data: Uint8Array): { done: Promise<void>; state: PumpState; abort: () => Promise<void> } {
  const state: PumpState = { error: undefined, failed: false };
  const writer = writable.getWriter();
  let stopped = false;
  const run = async (): Promise<void> => {
    for (let offset = 0; offset < data.length && !stopped; offset += INPUT_SLICE) {
      await writer.ready;
      await writer.write(data.subarray(offset, Math.min(offset + INPUT_SLICE, data.length)));
    }
    if (!stopped) await writer.close();
  };
  const done = run().catch((error: unknown) => {
    state.error = error;
    state.failed = true;
  });
  const abort = async (): Promise<void> => {
    stopped = true;
    await writer.abort().catch((error: unknown) => {
      state.error ??= error;
      state.failed = true;
    });
  };
  return { done, state, abort };
}

/**
 * Inflates a raw DEFLATE stream. Fails with `too-large` as soon as the output
 * would pass `maxBytes`, and with `corrupt` when the stream is not valid.
 */
export async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = platformStream("DecompressionStream");
  const feed = pump(stream.writable, data);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new InflateFailure("too-large", `inflated data exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch((cancelError: unknown) => {
      feed.state.error ??= cancelError;
    });
    await feed.abort();
    await feed.done;
    if (error instanceof InflateFailure) throw error;
    throw new InflateFailure("corrupt", "compressed data is not a valid DEFLATE stream", error);
  }
  await feed.done;
  if (feed.state.failed) {
    throw new InflateFailure("corrupt", "compressed data is not a valid DEFLATE stream", feed.state.error);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Compresses `data` to a raw DEFLATE stream. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = platformStream("CompressionStream");
  const feed = pump(stream.writable, data);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
  }
  await feed.done;
  if (feed.state.failed) {
    throw new InflateFailure("corrupt", "compression failed", feed.state.error);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
