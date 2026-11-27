import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { collectDesktopInventory, readCoreInventory, standardHerdrSocket } from "../../desktop/src/main/desktop-link/herdr-inventory";

import { createLocalTerminalHost } from "@desktop/main/local-terminals/host";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function core(rows: unknown[]) {
  const dir = await mkdtemp("/tmp/mx-inv-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = standardHerdrSocket({ XDG_RUNTIME_DIR: dir }, dir)!;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const calls: string[] = [];
  const server = createServer((socket) => {
    const decoder = new HcFrameDecoder();
    let framed = false;
    socket.on("data", (buf) => {
      if (!framed) {
        calls.push(JSON.parse(buf.toString()).method);
        socket.write(JSON.stringify({ id: 1, result: { version: "0.1.21", generation: 1, framed: true, features: [], methods: ["machine.list"] } }) + "\n");
        framed = true;
        return;
      }
      for (const frame of decoder.push(buf)) {
        const { id, method } = JSON.parse(frame.payload.toString());
        calls.push(method);
        socket.write(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ id, result: { machines: rows } }))));
      }
    });
  });
  server.listen(path);
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, path };
}

describe("Desktop Link read-only computer inventory", () => {
  it("reads standalone machines for the Terminal window without starting or contacting its private Core", async () => {
    const independent = await core([{ name: "remote-alias", target: "private-ssh-host", state: "connected" }]);
    const runtimeDir = dirname(dirname(independent.path));
    const host = createLocalTerminalHost({
      home: runtimeDir, env: { XDG_RUNTIME_DIR: runtimeDir }, shell: "/bin/sh",
      dataDir: join(runtimeDir, "private-data"), runtimeDir: join(runtimeDir, "private-runtime"),
      binaryPath: null, expectedVersion: "unused", uid: process.getuid!(),
      startCore: async () => { throw new Error("unexpected private Core start"); },
      openSocket: () => { throw new Error("unexpected private Core connection"); },
    }, { output: vi.fn(), closed: vi.fn() });
    try {
      expect(await host.standaloneMachines()).toEqual([{ name: "remote-alias", state: "connected" }]);
      expect(independent.calls).toEqual(["hello", "machine.list"]);
    } finally {
      host.dispose();
    }
  });

  it("reads both running Core inventories, projects safe names and states, and never opens a terminal", async () => {
    const independent = await core([{ name: "remote.test", target: "private-host", reason: "user@host", state: "unreachable" }]);
    const own = await core([{ name: "remote.test", state: "connected" }, { name: "ambiguous", state: "dialing" }]);
    const matrix = vi.fn(async () => ({ machines: [
      { name: "cloud", runtimeSlot: "dev", state: "connected" as const, source: "matrix" as const },
      { name: "cloud", runtimeSlot: "pr-42", state: "unknown" as const, source: "matrix" as const },
    ], partial: true }));
    const result = await collectDesktopInventory({ privateCore: own.path, defaultCore: independent.path }, "paired-owner", matrix);
    expect(result).toEqual({ machines: [
      { name: "remote.test", state: "connected", core: "private" }, { name: "ambiguous", state: "unknown", core: "private" },
      { name: "remote.test", state: "unreachable" },
      { name: "cloud", runtimeSlot: "dev", state: "connected", source: "matrix" },
      { name: "cloud", runtimeSlot: "pr-42", state: "unknown", source: "matrix" },
    ], partial: true });
    expect(matrix).toHaveBeenCalledWith("paired-owner");
    for (const host of [own, independent]) expect(host.calls).toEqual(["hello", "machine.list"]);
  });

  it("keeps reachable inventories on failure, limits the wire list and marks omitted rows", async () => {
    const host = await core(Array.from({ length: 34 }, (_, i) => ({ name: "host-" + i, state: "connected" })));
    const absent = join(dirname(host.path), "missing.sock");
    const result = await collectDesktopInventory({ privateCore: absent, defaultCore: host.path }, "owner");
    expect(result?.partial).toBe(true);
    expect(result?.machines).toHaveLength(32);
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await collectDesktopInventory({ defaultCore: absent }, "owner")).toBeUndefined();
  });

  it("leaves room in the 4 KiB heartbeat for long computer handles and slots", async () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({
      name: "a".repeat(60) + i, runtimeSlot: "dev-" + "x".repeat(28), source: "matrix" as const, state: "connected" as const,
    }));
    const result = await collectDesktopInventory({}, "owner", async () => ({ machines: rows, partial: false }));
    expect(result?.partial).toBe(true);
    expect(result!.machines.length).toBeGreaterThan(0);
    expect(result!.machines.length).toBeLessThan(32);
    expect(Buffer.byteLength(JSON.stringify({ t: "pong", herdrMachines: result!.machines, herdrMachinesPartial: true }))).toBeLessThanOrEqual(4096);
  });

  it("requires an owner-private socket directory and rejects traversal in a Core session", async () => {
    const host = await core([]);
    await chmod(dirname(host.path), 0o777);
    await expect(readCoreInventory(host.path)).rejects.toThrow();
    expect(host.calls).toEqual([]);
    expect(standardHerdrSocket({ HC_SESSION: "../other" }, "/home/example")).toBeUndefined();
    expect(standardHerdrSocket({}, "/home/example")).toBe("/home/example/.local/state/herdr-core/default/default.sock");
  });
});
