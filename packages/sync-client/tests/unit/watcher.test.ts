import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileWatcher } from "../../src/daemon/watcher.js";
import { parseSyncIgnore } from "../../src/lib/syncignore.js";

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for watcher condition");
}

describe("FileWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-watcher-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports file-processing errors through onError instead of throwing", async () => {
    const onError = vi.fn();
    const watcher = new FileWatcher({
      syncRoot: tempDir,
      ignorePatterns: parseSyncIgnore(""),
      onEvent: () => {
        throw new Error("watcher boom");
      },
      onError,
      debounceMs: 20,
    });

    watcher.start();
    await writeFile(join(tempDir, "note.txt"), "hello");

    await waitFor(() => onError.mock.calls.length > 0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "watcher boom" }));

    await watcher.stop();
  });
});
