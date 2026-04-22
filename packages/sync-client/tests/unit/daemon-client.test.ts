import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeDaemonSocket } from "../../src/cli/daemon-client.js";

describe("probeDaemonSocket", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-daemon-client-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns true when a daemon socket is live", async () => {
    const sock = join(tempDir, "daemon.sock");
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, resolve);
    });

    await expect(probeDaemonSocket(sock)).resolves.toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns false for a stale socket path", async () => {
    const sock = join(tempDir, "daemon.sock");
    await writeFile(sock, "stale");

    await expect(probeDaemonSocket(sock, 100)).resolves.toBe(false);
  });
});
