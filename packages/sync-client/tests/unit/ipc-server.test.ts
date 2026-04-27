import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const socketDir = join(tempDir, "private");
    const socketPath = join(socketDir, "ipc.sock");

    const server = new IpcServer({
      socketPath,
      handler: async () => ({ ok: true }),
    });
    await server.start();

    expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    await server.stop();
  });

  it("logs unexpected processMessage rejections instead of swallowing them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ipc-server-test-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "ipc.sock");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const server = new IpcServer({
      socketPath,
      handler: async () => ({ ok: true }),
    });
    (server as unknown as { processMessage: (socket: Socket, raw: string) => Promise<void> }).processMessage =
      vi.fn().mockRejectedValue(new Error("boom"));

    await server.start();

    const client = createConnection(socketPath);
    await once(client, "connect");
    client.write('{"id":"1","command":"status"}\n');

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith("[sync/ipc] processMessage failed:", "boom");
    });

    client.destroy();
    warnSpy.mockRestore();
    await server.stop();
  });

  it("returns a stable timeout error when a handler hangs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ipc-server-test-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "ipc.sock");

    const server = new IpcServer({
      socketPath,
      handlerTimeoutMs: 5,
      handler: async () => new Promise(() => undefined),
    });
    await server.start();

    const client = createConnection(socketPath);
    await once(client, "connect");
    client.write('{"id":"1","v":1,"command":"status","args":{}}\n');
    const [data] = await once(client, "data");

    expect(JSON.parse(String(data))).toEqual({
      id: "1",
      v: 1,
      error: { code: "request_timeout", message: "Request failed" },
    });

    client.destroy();
    await server.stop();
  });
});
