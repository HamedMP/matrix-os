import { createRequire } from "node:module";
import { connect } from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startOwnedTerminalHost } from "../../../packages/gateway/src/terminal/owned-host.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it("retains an immediate native error after missing root proof until first I/O handoff, without binding authority", async () => {
  const base = await mkdtemp("/tmp/t7early-"); cleanup.push(() => rm(base, { recursive: true, force: true }));
  const launchId = randomUUID().replaceAll("-", ""), directory = join(base, "matrix-terminal-" + launchId); await mkdir(directory, { mode: 0o700 });
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  const host = await startOwnedTerminalHost({ descriptor: { version: 1, kind: "terminal-native", launchId, generation: "gen_" + "a".repeat(64), directory, createdAt: new Date().toISOString(),
    launch: { command: "/bin/sh", args: ["-c", "printf 'EARLY-OWNED-ERROR\\n'; exit 7"], cwd: base, env: { PATH: "/usr/bin:/bin", HOME: base }, inheritEnv: false }, cols: 80, rows: 24 },
    digest: "b".repeat(64), ipc, pty: createRequire(import.meta.url)("node-pty"),
    readProcess: async () => { throw new Error("Named exited root proof unavailable"); } });
  cleanup.push(async () => { await host.stop(); await host.closed; });
  await host.exited; expect(host.running).toBe(false); expect(host.proofAvailable).toBe(false); expect(ipc.send).not.toHaveBeenCalled();
  let closed = false; void host.closed.then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  const socket = connect(host.path); let output = ""; socket.on("data", bytes => output += bytes);
  await new Promise<void>(resolve => socket.once("close", resolve));
  expect(output).toContain("EARLY-OWNED-ERROR"); await host.closed; expect(closed).toBe(true);
});
it("missing native proof keeps actual PTY I/O, reattach and size intact until explicit stop", async () => {
  const base = await mkdtemp("/tmp/t7own-"); cleanup.push(() => rm(base, { recursive: true, force: true }));
  const launchId = randomUUID().replaceAll("-", ""), directory = join(base, "matrix-terminal-" + launchId); await mkdir(directory, { mode: 0o700 });
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((_frame: unknown, done: (error?: Error | null) => void) => { done(); return true; }) });
  const host = await startOwnedTerminalHost({ descriptor: { version: 1, kind: "terminal-native", launchId, generation: "gen_" + "a".repeat(64), directory, createdAt: new Date().toISOString(),
    launch: { command: "/bin/sh", args: [], cwd: base, env: { PATH: "/usr/bin:/bin", HOME: base, TERM: "xterm-256color" }, inheritEnv: false }, cols: 80, rows: 24 },
    digest: "b".repeat(64), ipc, pty: createRequire(import.meta.url)("node-pty"),
    readProcess: async () => { throw new Error("Named missing native proof fixture"); } });
  cleanup.push(async () => { await host.stop(); await host.exited; });
  const pid = host.pid; expect(host.proofAvailable).toBe(false);
  const first = connect(host.path); first.on("error", () => {}); await new Promise<void>(resolve => first.once("connect", resolve)); first.destroy();
  ipc.emit("disconnect");
  const socket = connect(host.path); let output = ""; socket.setEncoding("utf8"); socket.on("data", data => output += data); socket.on("error", () => {});
  cleanup.push(async () => { socket.destroy(); });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(JSON.stringify({ type: "resize", cols: 109, rows: 37 }) + "\n");
  socket.write(JSON.stringify({ type: "input", data: "stty size; printf 'OWNED-%s\\n' alive\n" }) + "\n");
  await vi.waitFor(() => { expect(output).toContain("37 109"); expect(output).toContain("OWNED-alive"); });
  expect(host.pid).toBe(pid); expect(host.running).toBe(true); expect(ipc.send).not.toHaveBeenCalled();
  await host.stop(); await host.exited; expect(host.running).toBe(false);
});
