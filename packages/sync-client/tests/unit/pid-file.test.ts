import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePidFileExclusive } from "../../src/daemon/pid-file.js";

describe("daemon pid ownership", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-pid-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
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

  it("allows only one successor to recover a verified-dead pid file", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    await writeFile(pidPath, "1111");
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 1111) {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    });

    const candidates = [4242, 4343];
    const results = await Promise.allSettled(
      candidates.map((pid) => writePidFileExclusive(pidPath, pid)),
    );
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(pidPath, "utf-8")).toBe(String(candidates[winnerIndex]));
  });
});
