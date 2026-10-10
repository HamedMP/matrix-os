import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { isUnmodifiedBundledIcon } from "../../packages/gateway/src/bundled-icon-ownership";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
afterEach(() => vi.restoreAllMocks());
it("classifies replaced nonregular artwork without waiting for a writer and closes its descriptors", async () => {
  vi.spyOn(fs, "lstat").mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fs.lstat>>);
  const handle = { stat: vi.fn().mockResolvedValue({ isFile: () => false, size: 0 }), read: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  const opened = vi.spyOn(fs, "open").mockResolvedValue(handle as unknown as FileHandle);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await isUnmodifiedBundledIcon("/owner", { url: "/icons/notes.png", etag: '"r"', version: "r", versionedUrl: "/icons/notes.png?v=r" })).toBe(false);
  expect(opened).toHaveBeenCalledTimes(2);
  for (const [, flags] of opened.mock.calls) {
    expect((flags as number) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect((flags as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  }
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(2);
});
