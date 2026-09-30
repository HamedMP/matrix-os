import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { previewLocalChatSource, LocalChatPreviewError, LocalChatTransferError, type ImportHarness } from "@matrix-os/contracts/local-chat-import";
const MAX_RAW = 20 * 1024 ** 3;
const MAX_PART = 64 * 1024 ** 2;
/** One explicitly selected regular file; no adjacent file or credential discovery. */
export interface LocalChatCapture { size: number; dev: bigint; ino: bigint }
export async function openLocalChatSource(path: string, capture?: LocalChatCapture) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > BigInt(MAX_RAW) || !path.toLowerCase().endsWith(".jsonl")) throw new LocalChatPreviewError("invalid");
  if (capture && (info.dev !== capture.dev || info.ino !== capture.ino || !Number.isSafeInteger(capture.size) || capture.size < 1 || capture.size > MAX_RAW || info.size < BigInt(capture.size))) throw new LocalChatPreviewError("source_changed");
  const boundary = capture?.size ?? Number(info.size);
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: unknown) { if (!(error instanceof Error)) throw error; throw new LocalChatPreviewError("invalid"); }
  let closed = false;
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size < info.size) throw new LocalChatPreviewError("source_changed");
  } catch (error: unknown) { await file.close(); throw error; }
  const rawSize = boundary;
  const hash = () => { const value = createHash("sha256"); return { update(bytes: Uint8Array) { value.update(bytes); }, digest() { return value.digest("hex"); } }; };
  async function read(offset: number, length: number, signal: AbortSignal) {
    if (signal.aborted) throw new LocalChatTransferError("cancelled");
    if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > MAX_PART || offset + length > rawSize) throw new LocalChatTransferError("invalid");
    const current = await file.stat({ bigint: true });
    if (current.dev !== info.dev || current.ino !== info.ino || current.size < BigInt(boundary)) throw new LocalChatTransferError("source_changed");
    const bytes = new Uint8Array(length); let received = 0;
    while (received < length) {
      if (signal.aborted) throw new LocalChatTransferError("cancelled");
      const result = await file.read(bytes, received, Math.min(length - received, 1024 * 1024), offset + received);
      if (!result.bytesRead) throw new LocalChatTransferError("source_changed"); received += result.bytesRead;
    }
    return bytes;
  }
  return { rawSize, capture: { size:rawSize, dev:info.dev, ino:info.ino }, read, createHash: hash,
    async preview(harness: ImportHarness, signal: AbortSignal = AbortSignal.timeout(60 * 60_000)) {
      const digest = hash();
      async function* chunks() {
        for (let offset = 0; offset < rawSize; offset += 64 * 1024) {
          const bytes = await read(offset, Math.min(64 * 1024, rawSize - offset), signal); digest.update(bytes); yield bytes;
        }
      }
      return previewLocalChatSource(harness, { chunks: chunks(), rawSize, sourceHash: () => digest.digest(), signal });
    },
    async close() { if (!closed) { closed = true; await file.close(); } },
  };
}
