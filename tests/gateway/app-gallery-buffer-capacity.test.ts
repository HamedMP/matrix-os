import type { FileHandle } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedDirectory, readLimited } from "../../packages/gateway/src/app-gallery/pinned-directory";
import { DEFAULT_LIMITS, readTemplate } from "../../packages/gateway/src/app-gallery/filesystem";

afterEach(() => vi.restoreAllMocks());

function directoryWithFile(content: Buffer, reportedSize = content.length) {
  let position = 0;
  const close = vi.fn(async () => {});
  const handle = {
    stat: async () => ({ isFile: () => true, size: reportedSize }),
    read: async (target: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(length, content.length - position);
      content.copy(target, offset, position, position + bytesRead);
      position += bytesRead;
      return { bytesRead, buffer: target };
    },
    close,
  } as unknown as FileHandle;
  const directory = new PinnedDirectory({} as FileHandle);
  vi.spyOn(directory, "openFile").mockResolvedValue(handle);
  return { directory, close };
}

describe("gallery bounded read allocations", () => {
  it("retains only small content rather than the maximum read allocation", async () => {
    const content = Buffer.from("small template file");
    const { directory, close } = directoryWithFile(content);
    const bytes = await directory.readFile("small.txt", DEFAULT_LIMITS.maxFileBytes);
    expect(bytes).toEqual(content);
    expect(bytes.buffer.byteLength).toBeLessThanOrEqual(Buffer.poolSize);
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains an exact independent allocation for content above the small-buffer pool", async () => {
    const content = Buffer.alloc(9000, 42);
    const { directory } = directoryWithFile(content);
    const bytes = await directory.readFile("medium.txt", DEFAULT_LIMITS.maxFileBytes);
    expect(bytes).toEqual(content);
    expect(bytes.buffer.byteLength).toBe(content.length);
  });

  it("accepts content exactly at the byte limit", async () => {
    const { directory } = directoryWithFile(Buffer.from("12345"));
    expect(String(await directory.readFile("exact.txt", 5))).toBe("12345");
  });

  it("rejects oversized content before reading and closes its handle", async () => {
    const { directory, close } = directoryWithFile(Buffer.from("123456"));
    await expect(directory.readFile("oversized.txt", 5)).rejects.toThrow("Invalid file");
    expect(close).toHaveBeenCalledOnce();
  });

  it("still detects growth beyond the limit after the initial stat", async () => {
    const { directory, close } = directoryWithFile(Buffer.from("123456"), 1);
    await expect(directory.readFile("growing.txt", 5)).rejects.toThrow("File too large");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform !== "linux")("gallery filesystem retained capacity", () => {
  it("bounds retained capacity through both readLimited and template traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "gallery-buffer-"));
    try {
      for (let index = 0; index < 40; index++) await writeFile(join(root, `file-${index}`), "small");
      const single = await readLimited(join(root, "file-0"), DEFAULT_LIMITS.maxFileBytes);
      expect(single.buffer.byteLength).toBeLessThanOrEqual(Buffer.poolSize);
      const files = await readTemplate(root, DEFAULT_LIMITS);
      expect(files.size).toBe(40);
      expect([...files.values()].reduce((total, bytes) => total + bytes.buffer.byteLength, 0))
        .toBeLessThanOrEqual(40 * Buffer.poolSize);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
