import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FSWatcher } from "chokidar";

const HASH_STREAM_TIMEOUT_MS = 30_000;

export function hashFileStream(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    const timeout = setTimeout(() => {
      s.destroy(new Error(`hash stream timed out after ${HASH_STREAM_TIMEOUT_MS}ms`));
    }, HASH_STREAM_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => {
      cleanup();
      resolve(`sha256:${h.digest("hex")}`);
    });
    s.on("error", (err) => {
      cleanup();
      reject(err);
    });
    s.on("close", cleanup);
  });
}

export function hashBuffer(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

export type LocalPushFile =
  | { kind: "file"; body: Buffer; hash: string; size: number }
  | { kind: "too_large"; size: number }
  | { kind: "skip" };

export async function readLocalFileForPush(
  absPath: string,
  maxPushBytes: number,
): Promise<LocalPushFile> {
  let handle;
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      ["ENOENT", "EISDIR", "ELOOP", "ENOTDIR"].includes(
        String((err as NodeJS.ErrnoException).code),
      )
    ) {
      return { kind: "skip" };
    }
    throw err;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      return { kind: "skip" };
    }
    if (fileStat.size > maxPushBytes) {
      return { kind: "too_large", size: fileStat.size };
    }
    const body = Buffer.from(await handle.readFile());
    return {
      kind: "file",
      body,
      hash: hashBuffer(body),
      size: body.length,
    };
  } finally {
    await handle.close();
  }
}

// AWS SDK v3 returns its own stream type with `transformToByteArray()`,
// NOT a Web ReadableStream -- calling .getReader() throws "is not a function".
// Match what manifest.ts does for body decoding (transformToString fallback).
export async function streamToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
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
    for await (const chunk of chunks) {
      const buf = toChunk(chunk);
      total += buf.length;
      ensureWithinLimit(total);
      parts.push(buf);
    }
    return Buffer.concat(parts);
  };
  if (typeof anyBody.getReader === "function") {
    const reader = anyBody.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        ensureWithinLimit(total);
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  }
  if (typeof anyBody.stream === "function") {
    return streamToBuffer(anyBody.stream(), maxBytes);
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
    const bytes = await anyBody.transformToByteArray();
    ensureWithinLimit(bytes.length);
    return Buffer.from(bytes);
  }
  throw new Error("Unsupported R2 object body type");
}

export function createSerialQueue(onError: (err: unknown) => void): {
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  drain: () => Promise<void>;
} {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch((err: unknown) => {
      onError(err);
      return undefined;
    });
    return next;
  };
  return {
    enqueue,
    async drain(): Promise<void> {
      await chain;
    },
  };
}

export function waitForWatcherReady(target: FSWatcher): Promise<void> {
  // Resolve on `close` too, so a concurrent stop() can't strand us waiting
  // for a `ready` event that will never fire on a closed watcher.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.off("ready", onReady);
      target.off("error", onError);
      target.off("close", onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    target.once("ready", onReady);
    target.once("error", onError);
    target.once("close", onClose);
  });
}
