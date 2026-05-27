import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IPC_MAX_RESPONSE_BYTES,
  probeDaemonSocket,
  sendCommand,
} from "../../src/cli/daemon-client.js";

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("probeDaemonSocket", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-daemon-client-"));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns true when a daemon socket is live", async () => {
    const sock = join(tempDir, "daemon.sock");
    const server = createServer();

    await listen(server, sock);

    await expect(probeDaemonSocket(sock)).resolves.toBe(true);

    await closeServer(server);
  });

  it("returns false for a stale socket path", async () => {
    const sock = join(tempDir, "daemon.sock");
    await writeFile(sock, "stale");

    await expect(probeDaemonSocket(sock, 100)).resolves.toBe(false);
  });
});

describe("sendCommand", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-daemon-client-"));
    process.env.HOME = tempDir;
    await mkdir(join(tempDir, ".matrixos"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves a small newline-delimited daemon response", async () => {
    const sock = join(tempDir, ".matrixos", "daemon.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {
        socket.write(JSON.stringify({ v: 1, result: { syncing: true } }) + "\n");
      });
    });
    await listen(server, sock);

    try {
      await expect(sendCommand("sync.status", {}, 1000)).resolves.toEqual({
        syncing: true,
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  it("rejects oversized daemon responses before timing out", async () => {
    const sock = join(tempDir, ".matrixos", "daemon.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("x".repeat(IPC_MAX_RESPONSE_BYTES + 1));
    });
    await listen(server, sock);

    try {
      await expect(sendCommand("sync.status", {}, 1000)).rejects.toThrow(
        "IPC response too large",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });
});
