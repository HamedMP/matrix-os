import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSerialTaskQueue,
  persistPauseState,
  resolveWithinSyncRoot,
  writePidFileExclusive,
} from "../../src/daemon/index.js";
import { loadConfig, type SyncConfig } from "../../src/lib/config.js";

describe("daemon runtime guards", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-daemon-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves in-root paths", () => {
    expect(resolveWithinSyncRoot(tempDir, "notes/today.md")).toBe(
      join(tempDir, "notes/today.md"),
    );
  });

  it("rejects traversal outside the sync root", () => {
    expect(() => resolveWithinSyncRoot(tempDir, "../../.ssh/authorized_keys")).toThrow(
      "Remote event path escapes sync root",
    );
  });

  it("creates the pid file exclusively", async () => {
    const pidPath = join(tempDir, "daemon.pid");

    await writePidFileExclusive(pidPath, 4242);

    expect(await readFile(pidPath, "utf-8")).toBe("4242");
  });

  it("rejects a live daemon pid", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    await writeFile(pidPath, "1111");
    vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(writePidFileExclusive(pidPath, 4242)).rejects.toThrow(
      "Sync daemon already running",
    );
  });

  it("replaces a stale pid file", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    await writeFile(pidPath, "1111");
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    await writePidFileExclusive(pidPath, 4242);

    expect(await readFile(pidPath, "utf-8")).toBe("4242");
  });

  it("persists pause state changes", async () => {
    const configPath = join(tempDir, "config.json");
    const config: SyncConfig = {
      platformUrl: "https://platform.matrix-os.com",
      gatewayUrl: "https://app.matrix-os.com",
      syncPath: join(tempDir, "sync"),
      gatewayFolder: "",
      peerId: "test-peer",
      pauseSync: false,
    };
    await mkdir(config.syncPath, { recursive: true });

    await persistPauseState(config, true, configPath);

    expect(config.pauseSync).toBe(true);
    await expect(loadConfig(configPath)).resolves.toMatchObject({ pauseSync: true });
  });

  it("logs serial queue task failures and keeps later tasks running", async () => {
    const onError = vi.fn();
    const enqueue = createSerialTaskQueue(onError);
    const events: string[] = [];

    await expect(
      enqueue(async () => {
        events.push("first");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      enqueue(async () => {
        events.push("second");
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["first", "second"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
