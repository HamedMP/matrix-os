import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { startOwnedTerminalHost } from "../../../packages/gateway/src/terminal/owned-host.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const base = await mkdtemp("/tmp/t7final-"); cleanups.push(() => rm(base, { recursive: true, force: true }));
  const launchId = randomUUID().replaceAll("-", ""), directory = join(base, "matrix-terminal-" + launchId); await mkdir(directory, { mode: 0o700 });
  let data!: (bytes: string) => void, exit!: () => void;
  // Named native-event fixture. The viewer is a real UDS; no identity/authority is issued.
  const child = { pid: 123, pause() {}, resume() {}, write() {}, resize() {}, kill() { exit(); },
    onData(fn: typeof data) { data = fn; return { dispose() {} }; }, onExit(fn: typeof exit) { exit = fn; return { dispose() {} }; } };
  const host = await startOwnedTerminalHost({ descriptor: { version: 1, kind: "terminal-native", launchId, generation: "gen_" + "a".repeat(64), directory, createdAt: new Date().toISOString(),
    launch: { command: "/bin/sh", args: [], cwd: base, env: { PATH: "/usr/bin:/bin", HOME: base }, inheritEnv: false }, cols: 80, rows: 24 },
    digest: "b".repeat(64), pty: { spawn: () => child as unknown as IPty } });
  cleanups.push(async () => { await host.stop(); await host.closed; });
  const viewer = connect(host.path); let output = "";
  viewer.on("data", bytes => output += bytes); cleanups.push(async () => { viewer.destroy(); });
  await new Promise<void>((resolve, reject) => { viewer.once("connect", resolve); viewer.once("error", reject); });
  data("ATTACHED-READY\n"); await vi.waitFor(() => expect(output.includes("ATTACHED-READY")).toBe(true));
  return { host, viewer, data, exit, output: () => output };
}
it("flushes an already attached temporarily slow viewer's final suffix before closing I/O", async () => {
  const f = await fixture(); f.viewer.pause();
  const final = "x".repeat(248 * 1024) + "FINAL-NATIVE-SUFFIX\n";
  const closed = new Promise<void>(resolve => f.viewer.once("close", resolve));
  f.data(final); f.exit(); await f.host.exited;
  expect(f.host.running).toBe(false); expect(f.host.proofAvailable).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 150)); f.viewer.resume();
  await closed; await f.host.closed;
  expect(f.output().endsWith(final)).toBe(true);
});
it("bounds final drainage for a permanently stalled viewer while native exit is already settled", async () => {
  const f = await fixture(); f.viewer.pause();
  f.data("x".repeat(248 * 1024) + "STALLED-FINAL\n"); f.exit(); await f.host.exited;
  const started = Date.now();
  await f.host.closed;
  expect(Date.now() - started).toBeLessThan(6000);
  expect(f.host.running).toBe(false);
});
it("explicit stop cancels final drainage instead of waiting for a stalled pane", async () => {
  const f = await fixture(); f.viewer.pause();
  f.data("x".repeat(248 * 1024)); f.exit(); await f.host.exited;
  await new Promise(resolve => setTimeout(resolve, 30)); const started = Date.now();
  await f.host.stop(); await f.host.closed;
  expect(Date.now() - started).toBeLessThan(500);
});
