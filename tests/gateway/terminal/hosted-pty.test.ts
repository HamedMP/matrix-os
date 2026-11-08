import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import type { IPty } from "node-pty";
import { createHostedTerminalPty } from "../../../packages/gateway/src/terminal/hosted-pty.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
async function fixture(args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "t7-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const host = await createHostedTerminalPty({ directory, launch: { command: "/bin/sh", args, cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory, TERM: "xterm-256color" } }, cols: 80, rows: 24 });
  cleanups.push(async () => { await host.stop(); await host.close(); });
  return host;
}
async function viewer(path: string) {
  const socket = connect(path); let output = "";
  socket.setEncoding("utf8"); socket.on("data", bytes => output += bytes);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  cleanups.push(async () => { socket.destroy(); });
  return { socket, get output() { return output; }, send(value: unknown) { socket.write(JSON.stringify(value) + "\n"); } };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!test()) { if (Date.now() > deadline) throw new Error("PTY assertion deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const requirePty = createRequire(new URL("../../../packages/gateway/src/terminal/hosted-pty.ts", import.meta.url));

function observeNativeInput(change?: (terminal: IPty) => void) {
  const nodePty = requirePty("node-pty") as typeof import("node-pty");
  const spawn = nodePty.spawn;
  const accepted: string[] = [];
  vi.spyOn(nodePty, "spawn").mockImplementationOnce((...args) => {
    const terminal = spawn(...args);
    const write = terminal.write.bind(terminal);
    vi.spyOn(terminal, "write").mockImplementation(data => {
      accepted.push(data.toString());
      write(data);
    });
    change?.(terminal);
    return terminal;
  });
  return accepted;
}

async function stalledFixture() {
  const host = await fixture(["-c", [
    'stty raw -echo || exit 1',
    'while [ ! -f "$HOME/start" ]; do sleep 0.01; done',
    "printf 'READY\\n'",
    'while [ ! -f "$HOME/read" ]; do sleep 0.01; done',
    'exec /bin/cat',
  ].join("\n")]);
  const observer = await viewer(host.path);
  const directory = dirname(host.path);
  await writeFile(join(directory, "start"), "");
  await until(() => observer.output === "READY\n");
  return { host, observer, release: () => writeFile(join(directory, "read"), "") };
}

async function sendObserved(peer: Awaited<ReturnType<typeof viewer>>, accepted: string[], data: string) {
  const before = accepted.length;
  peer.send({ type: "input", data });
  await until(() => accepted.length > before || peer.socket.destroyed);
}

describe("actual /bin/sh PTY lifetime, independently of source proof", () => {
  it("continues input and actual pane resize after detach and proof outage; stop waits for root exit", async () => {
    const host = await fixture(), pid = host.pid;
    const first = await viewer(host.path);
    first.send({ type: "input", data: "printf 'FIRST-%s\\n' ok\n" }); await until(() => first.output.includes("FIRST-ok"));
    first.socket.destroy(); host.closeProof();
    expect(host.pid).toBe(pid); expect(host.running).toBe(true);
    const second = await viewer(host.path);
    second.send({ type: "resize", cols: 113, rows: 41 });
    second.send({ type: "input", data: "stty size; printf 'SECOND-%s\\n' ok\n" });
    await until(() => second.output.includes("41 113") && second.output.includes("SECOND-ok"));
    expect(host.pid).toBe(pid); expect(host.running).toBe(true);
    await host.stop(); expect(host.running).toBe(false);
  });
  it("malformed I/O viewer and controller detach never terminate the native root", async () => {
    const host = await fixture(), bad = await viewer(host.path);
    bad.send({ type: "input", data: "echo forged", ownerId: "fake" }); await until(() => bad.socket.destroyed);
    expect(host.running).toBe(true);
    host.closeProof(); const good = await viewer(host.path);
    good.send({ type: "input", data: "printf 'LIVE-%s\\n' ok\n" }); await until(() => good.output.includes("LIVE-ok"));
  });

  it("bounds aggregate UTF-8 input while the real PTY is stalled and keeps accepted frames in order", async () => {
    const accepted = observeNativeInput();
    const { host, observer, release } = await stalledFixture();
    const flood = await viewer(host.path);
    const frames = Array.from({ length: 20 }, (_, index) => `FRAME-${index}:${"é".repeat(5990)}\n`);
    try {
      for (const [index, frame] of frames.entries()) {
        if (flood.socket.destroyed) break;
        await sendObserved(index < 4 && index % 2 === 0 ? observer : flood, accepted, frame);
      }
      expect(flood.socket.destroyed).toBe(true);
      expect(observer.socket.destroyed).toBe(false);
      expect(host.running).toBe(true);
      expect(accepted.length).toBeGreaterThanOrEqual(4);
      expect(accepted.length).toBeLessThan(10);
      expect(accepted).toEqual(frames.slice(0, accepted.length));
    } finally { await release(); }
    const output = "READY\n" + accepted.join("");
    await until(() => observer.output.length >= output.length);
    expect(observer.output).toBe(output);
    observer.send({ type: "input", data: "STILL-LIVE\n" });
    await until(() => observer.output.endsWith("STILL-LIVE\n"));
  });

  it("bounds the number of retained frames even when each queued frame is one byte", async () => {
    const accepted = observeNativeInput();
    const { host, observer, release } = await stalledFixture();
    const flood = await viewer(host.path);
    try {
      for (let index = 0; index < 4; index++) await sendObserved(observer, accepted, "a".repeat(12_000));
      flood.socket.write((JSON.stringify({ type: "input", data: "b" }) + "\n").repeat(600));
      await until(() => flood.socket.destroyed || accepted.length === 604);
      expect(flood.socket.destroyed).toBe(true);
      expect(observer.socket.destroyed).toBe(false);
      expect(accepted.length).toBeGreaterThanOrEqual(256);
      expect(accepted.length).toBeLessThanOrEqual(260);
    } finally { await release(); }
  });

  it.each(["version", "queue"] as const)("fails closed before a native write with unknown %s", async fault => {
    const packageInfo = requirePty("node-pty/package.json") as { version: string };
    const version = packageInfo.version;
    if (fault === "version") packageInfo.version = "0.0.0";
    const accepted = observeNativeInput(fault === "queue" ? terminal => {
      Object.defineProperty(terminal, "_writeStream", { value: undefined });
    } : undefined);
    try {
      const host = await fixture();
      const peer = await viewer(host.path);
      await sendObserved(peer, accepted, "printf 'must not be written'\n");
      expect(accepted).toEqual([]);
      expect(peer.socket.destroyed).toBe(true);
      expect(host.running).toBe(true);
    } finally { packageInfo.version = version; }
  });
});
