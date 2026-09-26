import { awaitMirrorOperation } from "./home-mirror-abort.js";

// Match what manifest.ts does for body decoding (transformToString fallback).
export async function streamToBuffer(body: unknown, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const anyBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
    stream?: () => ReadableStream<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  const toChunk = (value: unknown): Buffer => {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value);
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error("Unsupported R2 object chunk type");
  };
  const ensureWithinLimit = (size: number): void => {
    if (size > maxBytes) {
      throw new Error(`remote blob exceeded ${maxBytes} bytes`);
    }
  };
  const readChunks = async (
    chunks: AsyncIterable<unknown>,
  ): Promise<Buffer> => {
    const parts: Buffer[] = [];
    let total = 0;
    const iterator = chunks[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = iterator.next();
        const { value, done } = signal ? await awaitMirrorOperation(next, signal) : await next;
        signal?.throwIfAborted();
        if (done) break;
        const buf = toChunk(value);
        total += buf.length;
        ensureWithinLimit(total);
        parts.push(buf);
      }
    } finally {
      if (signal?.aborted && iterator.return) {
        // Cleanup itself may not cooperate: request it without delaying shutdown.
        void iterator.return().catch((error: unknown) => console.warn("[home-mirror] iterator cleanup failed", error instanceof Error ? "error" : "non-error"));
      }
    }
    return Buffer.concat(parts);
  };
  if (typeof anyBody.getReader === "function") {
    const reader = anyBody.getReader();
    const cancel = () => { void reader.cancel(signal?.reason).catch((error: unknown) => console.warn("[home-mirror] body cancellation failed", error instanceof Error ? "error" : "non-error")); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = signal ? await awaitMirrorOperation(reader.read(), signal) : await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value) {
        total += value.length;
        ensureWithinLimit(total);
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
    } finally {
      signal?.removeEventListener("abort", cancel);
      try { reader.releaseLock(); } catch (error: unknown) { console.warn("[home-mirror] reader cleanup failed", error instanceof Error ? "error" : "non-error"); }
    }
  }
  if (typeof anyBody.stream === "function") {
    return streamToBuffer(anyBody.stream(), maxBytes, signal);
  }
  if (typeof anyBody[Symbol.asyncIterator] === "function") {
    return readChunks(body as AsyncIterable<unknown>);
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const buf = toChunk(body);
    ensureWithinLimit(buf.length);
    return buf;
  }
  if (typeof anyBody.transformToByteArray === "function") {
    const bytes = signal ? await awaitMirrorOperation(anyBody.transformToByteArray(), signal) : await anyBody.transformToByteArray();
    ensureWithinLimit(bytes.length);
    return Buffer.from(bytes);
  }
  throw new Error("Unsupported R2 object body type");
}

