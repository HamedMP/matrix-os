import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { createHostedTerminalPty } from "../../../packages/gateway/src/terminal/hosted-pty.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp("/tmp/t7initial-"); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let emitData!: (bytes: string) => void, emitExit!: () => void;
  // Named PTY-event fixture only; no process identity or source authority.
  const child = { pid: 123, pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    onData: (fn: (bytes: string) => void) => { emitData = fn; return { dispose() {} }; },
    onExit: (fn: () => void) => { emitExit = fn; return { dispose() {} }; } };
  const host = await createHostedTerminalPty({ directory, launch: { command: "/bin/sh", args: [], cwd: directory, env: {} }, cols: 80, rows: 24,
    pty: { spawn: () => child as unknown as IPty } });
  cleanup.push(host.close);
  return { host, child, data: (bytes: string) => emitData(bytes), exit: () => emitExit() };
}
it("caps initial handoff, pauses large output, fences exit and marks an incomplete tail explicitly", async () => {
  const f = await fixture(); f.data("x".repeat(300 * 1024)); expect(f.child.pause).toHaveBeenCalledOnce();
  f.exit(); await f.host.exited; expect(f.host.signal.aborted).toBe(true);
  const socket = connect(f.host.path); let output = "";
  socket.once("connect", () => socket.write(JSON.stringify({ type: "resize", cols: 97, rows: 31 }) + "\n" + JSON.stringify({ type: "input", data: "late input\n" }) + "\n"));
  socket.on("data", bytes => output += bytes); await new Promise<void>(resolve => socket.once("close", resolve));
  await f.host.initialOutputDelivered;
  expect(output).toBe("x".repeat(256 * 1024) + "\r\n[Initial terminal output may be incomplete.]\r\n");
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
  expect(f.child.write).not.toHaveBeenCalled(); expect(f.child.resize).not.toHaveBeenCalled();
});
it("bounds post-exit initial retention to30seconds and explicit stop cancels it", async () => {
  const f = await fixture(); vi.useFakeTimers();
  f.data("initial error"); f.exit(); await f.host.exited;
  let delivered = false; void f.host.initialOutputDelivered.then(() => { delivered = true; });
  await vi.advanceTimersByTimeAsync(29999); expect(delivered).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(delivered).toBe(true);
  const stopped = await fixture(); stopped.data("other error"); stopped.exit();
  await stopped.host.stop(); await stopped.host.initialOutputDelivered;
  expect(stopped.child.kill).not.toHaveBeenCalled(); expect(stopped.host.signal.aborted).toBe(true);
});
it("observes actual native root exit and proof fencing while initial reads are paused before any pane", async () => {
  const directory = await mkdtemp("/tmp/t7paused-"); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const native = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  let paused = false, nativeChild: IPty | undefined;
  const host = await createHostedTerminalPty({ directory, launch: { command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(300*1024));setInterval(()=>{},1000)"], cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory } }, cols: 80, rows: 24,
    pty: { spawn: (command, args, options) => {
      const child = native.spawn(command, args, options), pause = child.pause.bind(child), resume = child.resume.bind(child);
      child.pause = () => { paused = true; pause(); }; child.resume = () => { paused = false; resume(); }; nativeChild = child; return child;
    } } });
  cleanup.push(async () => { nativeChild?.resume(); await host.stop(); await host.close(); });
  await vi.waitFor(() => expect(paused).toBe(true));
  process.kill(host.pid, "SIGKILL");
  await vi.waitFor(() => expect(host.signal.aborted).toBe(true), { timeout: 3000 }); await host.exited;
  expect(host.running).toBe(false); expect(host.signal.aborted).toBe(true);
  const socket = connect(host.path); let output = "";
  socket.on("data", bytes => output += bytes); await new Promise<void>(resolve => socket.once("close", resolve));
  expect(output.length).toBeLessThanOrEqual(256 * 1024 + 100);
  expect(output.includes("[Initial terminal output may be incomplete.]")).toBe(true);
});
