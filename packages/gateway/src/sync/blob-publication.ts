import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
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

async function* bodyChunks(body: unknown): AsyncGenerator<Uint8Array> {
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    for await (const chunk of candidate as AsyncIterable<unknown>) {
      yield typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk as ArrayBufferLike);
    }
    return;
  }
  if (typeof candidate.getReader === "function") {
    const reader = candidate.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      reader.releaseLock();
    }
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
}): Promise<{ objectKey: string }> {
  const stagingKey = buildStagingKey(input.scope, input.stagingId);
  const objectKey = buildBlobKey(input.scope, input.expectedHash);
  const tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-finalize-"));
  const tempPath = join(tempDir, "blob");
  const handle = await open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    let staged;
    try {
      staged = await input.r2.getObject(stagingKey, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: unknown) {
      if (noSuchKey(err)) throw new StagedObjectValidationError("missing");
      throw err;
    }
    if (!staged.body) throw new StagedObjectValidationError("missing");
    if (
      typeof staged.contentLength === "number"
      && staged.contentLength > MAX_STAGED_BLOB_BYTES
    ) {
      throw new StagedObjectValidationError("too_large");
    }
    if (
      typeof staged.contentLength === "number"
      && staged.contentLength !== input.expectedSize
    ) {
      throw new StagedObjectValidationError("size_mismatch");
    }

    await Promise.race([
      (async () => {
        for await (const chunk of bodyChunks(staged.body)) {
          size += chunk.byteLength;
          if (size > MAX_STAGED_BLOB_BYTES || size > input.expectedSize) {
            throw new StagedObjectValidationError("too_large");
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await handle.write(chunk, offset, chunk.byteLength - offset);
            offset += result.bytesWritten;
          }
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Staged sync object validation timed out")),
          STAGING_READ_TIMEOUT_MS,
        );
      }),
    ]);
    if (size !== input.expectedSize) {
      throw new StagedObjectValidationError("size_mismatch");
    }
    const actualHash = `sha256:${hash.digest("hex")}`;
    if (actualHash !== input.expectedHash) {
      throw new StagedObjectValidationError("hash_mismatch");
    }

    await handle.close();
    await input.r2.putObject(objectKey, createReadStream(tempPath));
    try {
      await input.r2.deleteObject(stagingKey);
    } catch (err: unknown) {
      console.warn(
        "[sync/publication] Failed to remove finalized staging object:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return { objectKey };
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await handle.close();
    } catch (err: unknown) {
      console.warn("[sync/publication] Failed to close a staging validation handle", {
        errorType: err instanceof Error ? err.name : "NonErrorThrown",
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
