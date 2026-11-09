import type { FileHandle } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
/** Decode archives as streams. Offsets describe decoded JSONL; compressed bytes stay intact in backup. */
export async function* usageInput(
  handle: FileHandle,
  path: string,
  size: number,
  start: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  async function* raw() {
    let position = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (!bytesRead) throw new Error("Usage source truncated");
      position += bytesRead;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  }
  let source: AsyncIterable<Uint8Array>;
  if (path.endsWith(".zst"))
    source = Readable.from(raw()).compose(createZstdDecompress());
  else if (path.endsWith(".json")) {
    if (size > 16 * 1024 * 1024)
      throw new RangeError("Legacy JSON needs streaming migration");
    const data = Buffer.alloc(size);
    await handle.read(data, 0, size, 0);
    const value = JSON.parse(data.toString("utf8"));
    if (!value.session || !Array.isArray(value.items))
      throw new Error("Unsupported legacy session");
    async function* legacy() {
      yield Buffer.from(
        JSON.stringify({
          type: "session_meta",
          timestamp: value.session.timestamp,
          payload: { id: value.session.id },
        }) + "\n",
      );
      for (const item of value.items)
        yield Buffer.from(
          JSON.stringify({
            type: item.type,
            timestamp: item.timestamp ?? value.session.timestamp,
            payload: { type: item.type, usage: item.usage },
          }) + "\n",
        );
    }
    source = legacy();
  } else source = raw();
  let offset = 0;
  try {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      const end = offset + chunk.length;
      if (end > 100 * 1024 ** 3)
        throw new RangeError("Usage source expansion limit");
      if (end > start) yield chunk.subarray(Math.max(0, start - offset));
      offset = end;
    }
  } finally {
    if (source instanceof Readable) source.destroy();
  }
}
