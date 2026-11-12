import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
/** Hash each committed byte once per pass; offsets are raw bytes, never decoded archive offsets. */
export function committedHash(handle: FileHandle, signal?: AbortSignal) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  return async (end: number) => {
    if (end < position) throw new RangeError("Usage hash moved backwards");
    while (position < end) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (!bytesRead) throw new Error("Usage source truncated");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.copy().digest("hex");
  };
}
