import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { IpcServer } from "../../src/daemon/ipc-server.js";

describe("IpcServer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("drops clients whose buffered request exceeds the max size before a newline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ipc-server-test-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "ipc.sock");

    const server = new IpcServer({
      socketPath,
      handler: async () => ({ ok: true }),
    });
    await server.start();

    const client = createConnection(socketPath);
    await once(client, "connect");
    client.write("x".repeat(70_000));
    await once(client, "close");

    await server.stop();
  });

  it("creates the socket with owner-only permissions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ipc-server-test-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "ipc.sock");

    const server = new IpcServer({
      socketPath,
      handler: async () => ({ ok: true }),
    });
    await server.start();

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    await server.stop();
  });
});
