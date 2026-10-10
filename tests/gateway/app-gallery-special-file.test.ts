import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { PinnedDirectory } from "../../packages/gateway/src/app-gallery/pinned-directory";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
afterEach(() => vi.restoreAllMocks());
it("opens a nonregular manifest without waiting for a FIFO writer and closes its descriptor", async () => {
  const handle = { stat: vi.fn().mockResolvedValue({ isFile: () => false, size: 0 }), close: vi.fn().mockResolvedValue(undefined) };
  const opened = vi.spyOn(fs, "open").mockResolvedValue(handle as unknown as FileHandle);
  const directory = new PinnedDirectory({ fd: 123 } as FileHandle);
  await expect(directory.readFile("matrix.json", 100)).rejects.toThrow();
  const flags = opened.mock.calls[0][1] as number;
  expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  expect(handle.close).toHaveBeenCalledOnce();
});
