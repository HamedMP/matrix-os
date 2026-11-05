import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";

async function exchange(path: string, frame: object) {
  return new Promise<string>((resolve, reject) => {
    const client = createConnection(path);
    let received = "";
    client.setEncoding("utf8");
    client.on("data", chunk => { received += chunk; });
    client.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ECONNRESET" && code !== "EPIPE") reject(error);
    });
    client.on("connect", () => client.end(JSON.stringify(frame) + "\n"));
    client.on("close", () => resolve(received));
  });
}

function createPeer() {
  return createServer({ allowHalfOpen: true }, socket => {
    socket.resume();
    socket.on("end", () => socket.end("peer"));
  });
}

const requestId = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const roles = ["supervisor", "broker"] as const;
async function fixture(role: typeof roles[number], close = vi.fn(async () => {})) {
  const root = await createUnixSocketTempDir();
  const parent = join(root, "own"), ipc = join(parent, "ipc");
  await mkdir(ipc, { recursive: true });
  const socketPath = join(ipc, "service");
  const options = { socketPath, namespaceTrust: { root, uid: process.getuid!() } };
  const handle = vi.fn();
  const server = role === "supervisor"
    ? createScopeRuntimeServer({ ...options, controller: { handle, close } })
    : createScopeRuntimeBrokerServer({ ...options, broker: { handle, close } });
  const frame = role === "supervisor" ? { version: 1, requestId, type: "capability.get" }
    : { version: 1, requestId, action: "egress.fetch", method: "GET", url: "https://example.org",
      accept: "application/json", runtimeHandle: "runtime_" + "a".repeat(32), executionGeneration: "1" };
  handle.mockResolvedValue(role === "supervisor"
    ? { version: 1, requestId, ok: false, type: "capability.result", error: "runtime_unavailable" }
    : { version: 1, requestId, ok: false, error: "action_denied" });
  await server.start();
  const cleanup = async () => {
    await chmod(parent, 0o700);
    await server.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, socketPath, server, parent, ipc, handle, close, frame, cleanup };
}

it.each(roles)("%s refuses unsafe shutdown, stops dispatch, and retries the original listener", async role => {
  const f = await fixture(role);
  try {
    expect(JSON.parse(await exchange(f.socketPath, f.frame))).toMatchObject({ requestId });
    f.handle.mockClear();
    const pending = createConnection(f.socketPath);
    pending.resume();
    const disconnected = new Promise<void>((resolve, reject) => {
      pending.on("error", reject);
      pending.on("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => pending.once("connect", resolve).once("error", reject));
    pending.write("{"); // Incomplete, already-connected frame must not survive a failed close.
    await chmod(f.parent, 0o770);
    const results = await Promise.allSettled([f.server.close(), f.server.close()]);
    expect.soft(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect.soft(await exchange(f.socketPath, f.frame)).toBe("");
    expect.soft(f.handle).not.toHaveBeenCalled();
    await disconnected;
    if (role === "broker") expect.soft(f.close).toHaveBeenCalledOnce();
    else expect.soft(f.close).not.toHaveBeenCalled();
    await expect.soft(f.server.close()).rejects.toThrow();
    await chmod(f.parent, 0o700);
    await Promise.all([f.server.close(), f.server.close()]);
    await f.server.close();
    await expect.soft(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.close).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});

it.each(roles)("%s preserves a replacement socket until the owned inode is restored", async role => {
  const f = await fixture(role);
  const moved = join(f.parent, "saved");
  const peer = createPeer();
  await rename(f.socketPath, moved);
  await new Promise<void>((resolve, reject) => peer.once("error", reject).listen(f.socketPath, resolve));
  try {
    const before = await lstat(f.socketPath, { bigint: true });
    await expect.soft(f.server.close()).rejects.toThrow();
    expect.soft((await lstat(f.socketPath, { bigint: true }).catch(() => null))?.ino).toBe(before.ino);
    expect.soft(await exchange(f.socketPath, f.frame)).toBe("peer");
    expect.soft(await exchange(moved, f.frame)).toBe("");
    expect(f.handle).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>(resolve => peer.close(() => resolve()));
    await rename(moved, f.socketPath);
    await f.cleanup();
  }
});

// Root bypasses the directory write permission that exercises libuv's failed unlink.
it.skipIf(process.getuid?.() === 0).each(roles)("%s retries removal of its stale socket after native close", async role => {
  const f = await fixture(role);
  const saved = join(f.ipc, "saved");
  const peer = createPeer();
  try {
    const original = await lstat(f.socketPath, { bigint: true });
    await chmod(f.ipc, 0o500);
    const attempts = await Promise.allSettled([f.server.close(), f.server.close()]);
    expect.soft(attempts.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(await lstat(f.socketPath, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });
    await expect(exchange(f.socketPath, f.frame)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect.soft(f.server.close()).rejects.toThrow();

    if (role === "broker") expect(f.close).toHaveBeenCalledOnce();
    await chmod(f.ipc, 0o700);
    await chmod(f.parent, 0o770);
    await expect(f.server.close()).rejects.toThrow("Unsafe");
    expect(await lstat(f.socketPath, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });

    await chmod(f.parent, 0o700);
    await rename(f.socketPath, saved);
    try {
      await new Promise<void>((resolve, reject) => peer.once("error", reject).listen(f.socketPath, resolve));
      const replacement = await lstat(f.socketPath, { bigint: true });
      await expect.soft(f.server.close()).rejects.toThrow();
      expect(await lstat(f.socketPath, { bigint: true })).toMatchObject({ dev: replacement.dev, ino: replacement.ino });
      expect(await exchange(f.socketPath, f.frame)).toBe("peer");
    } finally {
      if (peer.listening) await new Promise<void>(resolve => peer.close(() => resolve()));
      await rename(saved, f.socketPath);
    }

    await Promise.all([f.server.close(), f.server.close()]);
    await expect.soft(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.server.close();
    expect(f.close).toHaveBeenCalledOnce();
  } finally {
    await chmod(f.ipc, 0o700);
    await f.cleanup();
  }
});

it.each(roles)("%s concurrent closes all wait for backend completion", async role => {
  const gate = Promise.withResolvers<void>();
  const close = vi.fn(() => gate.promise);
  const f = await fixture(role, close);
  try {
    const first = f.server.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    let done = false;
    const second = f.server.close().then(() => { done = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(done).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    await f.server.close();
    expect(close).toHaveBeenCalledOnce();
  } finally { gate.resolve(); await f.cleanup(); }
});
