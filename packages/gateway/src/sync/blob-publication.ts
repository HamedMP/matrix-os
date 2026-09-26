import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestScope } from "./manifest.js";
import type { R2Client } from "./r2-client.js";
import { buildBlobKey, buildStagingKey } from "./r2-keys.js";

const MAX_STAGED_BLOB_BYTES = 1024 * 1024 * 1024;
const STAGING_READ_TIMEOUT_MS = 5 * 60_000;

export class StagedObjectValidationError extends Error {
  constructor(readonly code: "missing" | "size_mismatch" | "hash_mismatch" | "too_large") {
    super("Staged sync object could not be validated");
    this.name = "StagedObjectValidationError";
  }
}

async function* bodyChunks(body: unknown, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
    destroy?: (error?: Error) => void;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  // Cancel the underlying reader, not just its async-generator wrapper. Otherwise
  // pipeline abort waits forever for a stalled reader.read() to finish.
  if (typeof candidate.getReader === "function") {
    const reader = candidate.getReader();
    const cancel = () => {
      void reader.cancel(signal.reason).catch((err: unknown) => {
        console.warn("[sync/publication] Reader cancellation failed", err);
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    const cancel = () => candidate.destroy?.(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      for await (const chunk of candidate as AsyncIterable<unknown>) {
        signal.throwIfAborted();
        yield typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk as ArrayBufferLike);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    return;
  }
  if (typeof candidate.transformToByteArray === "function") {
    yield await candidate.transformToByteArray();
    return;
  }
  throw new StagedObjectValidationError("missing");
}

function noSuchKey(err: unknown): boolean {
  return err instanceof Error && (err.name === "NoSuchKey" || err.message.includes("NoSuchKey"));
}

export async function finalizeStagedObject(input: {
  r2: R2Client;
  scope: ManifestScope;
  stagingId: string;
  expectedHash: string;
  expectedSize: number;
  signal?: AbortSignal;
}): Promise<{ objectKey: string }> {
  const signal = input.signal ?? AbortSignal.timeout(STAGING_READ_TIMEOUT_MS);
  signal.throwIfAborted();
  const stagingKey = buildStagingKey(input.scope, input.stagingId);
  const objectKey = buildBlobKey(input.scope, input.expectedHash);
  const tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-finalize-"));
  const tempPath = join(tempDir, "blob");
  const hash = createHash("sha256");
  let size = 0;
  try {
    let staged;
    try {
      staged = await input.r2.getObject(stagingKey, { signal });
    } catch (err: unknown) {
      if (noSuchKey(err)) throw new StagedObjectValidationError("missing");
      throw err;
    }
    if (!staged.body) throw new StagedObjectValidationError("missing");
    const source = Readable.from(bodyChunks(staged.body, signal));
    try {
      if (typeof staged.contentLength === "number" && staged.contentLength > MAX_STAGED_BLOB_BYTES) {
        throw new StagedObjectValidationError("too_large");
      }
      if (typeof staged.contentLength === "number" && staged.contentLength !== input.expectedSize) {
        throw new StagedObjectValidationError("size_mismatch");
      }
      // Pipeline cancellation waits for stream cleanup before deleting the temporary file.
      await pipeline(source, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > MAX_STAGED_BLOB_BYTES || size > input.expectedSize) {
            callback(new StagedObjectValidationError("too_large"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }), createWriteStream(tempPath, { flags: "wx", mode: 0o600 }), { signal });
    } finally {
      source.destroy();
      // A rejected header can leave the network body unread.
      const body = staged.body as unknown as { destroy?: () => void; cancel?: () => Promise<void>; locked?: boolean };
      if (body.destroy) body.destroy();
      else if (body.cancel && !body.locked) await body.cancel();
    }
    if (size !== input.expectedSize) throw new StagedObjectValidationError("size_mismatch");
    if (`sha256:${hash.digest("hex")}` !== input.expectedHash) throw new StagedObjectValidationError("hash_mismatch");
    signal.throwIfAborted();
    await uploadValidatedBlob(input.r2, objectKey, tempPath, size, signal);
    signal.throwIfAborted();
    // Keep staging available for retries after a lost commit response. The orphan
    // collector owns expiry; content-addressed accepted bytes cannot be overwritten
    // by replaying a staging upload.
    return { objectKey };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function uploadValidatedBlob(r2: R2Client, key: string, path: string, size: number, signal: AbortSignal): Promise<void> {
  if (size <= 100 * 1024 * 1024) {
    const body = createReadStream(path);
    try { await r2.putObject(key, body, { signal, contentLength: size }); }
    finally { body.destroy(); }
    return;
  }
  const uploadId = await r2.createMultipartUpload(key);
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const partSize = 16 * 1024 * 1024;
    for (let start = 0; start < size; start += partSize) {
      signal.throwIfAborted();
      const partNumber = parts.length + 1;
      const length = Math.min(partSize, size - start);
      const url = await r2.getPresignedPartUrl(key, uploadId, partNumber);
      const body = createReadStream(path, { start, end: start + length - 1 });
      try {
        const response = await fetch(url, {
          method: "PUT", body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: "half",
          headers: { "content-length": String(length) },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        } as RequestInit & { duplex: "half" });
        const etag = response.headers.get("etag");
        await response.body?.cancel();
        if (!response.ok || !etag) throw new Error("Sync multipart publication failed");
        parts.push({ partNumber, etag });
      } finally { body.destroy(); }
    }
    signal.throwIfAborted();
    await r2.completeMultipartUpload(key, uploadId, parts);
  } catch (err: unknown) {
    try { await r2.abortMultipartUpload(key, uploadId); }
    catch (cleanupError: unknown) { console.warn("[sync/publication] Multipart cleanup failed", cleanupError); }
    throw err;
  }
}
