import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, Socket, type Server } from "node:net";
import type { IPty } from "node-pty";
import { createHostedTerminalPty } from "../../../packages/gateway/src/terminal/hosted-pty.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
async function fixture(args: string[] = [], command = "/bin/sh") {
  const directory = await mkdtemp(join(tmpdir(), "t7-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const host = await createHostedTerminalPty({ directory, launch: { command, args, cwd: directory, env: { PATH: "/usr/bin:/bin", HOME: directory, TERM: "xterm-256color" } }, cols: 80, rows: 24 });
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

async function observingPty(expectedBytes: number) {
  const script = `
      process.stdin.setRawMode(true);
      const hash = require('node:crypto').createHash('sha256');
      let received = 0;
      process.stdin.on('data', chunk => {
        received += chunk.length;
        if (received <= ${expectedBytes}) hash.update(chunk);
        if (received === ${expectedBytes}) process.stdout.write('PASTE-' + hash.digest('hex'));
      });
      process.stdout.write('READY');
    `;
  const host = await fixture(["-e", script], process.execPath), pane = await viewer(host.path);
  await until(() => pane.output.includes("READY"));
  return { host, pane };
}

describe("actual /bin/sh PTY lifetime, independently of source proof", () => {
  it("fences an exited root before any pane attaches and delivers its initial error to that first pane", async () => {
    const host = await fixture(["-c", "printf 'EARLY-EXIT-ERROR\\n'; exit 7"]);
    await host.exited;
    expect(host.running).toBe(false);
    expect(host.signal.aborted).toBe(true);
    const pane = await viewer(host.path);
    const closed = new Promise<void>(resolve => pane.socket.once("close", resolve));
    pane.send({ type: "resize", cols: 80, rows: 24 });
    await closed;
    expect(pane.output).toContain("EARLY-EXIT-ERROR");
  });
  it("hands the pre-attachment startup paint to the first pane without replaying it on later attachment", async () => {
    const host = await fixture(["-c", "printf '\\033[2J\\033[HSTARTUP-PAINT'; printf ready > startup-ready; exec /bin/sh"]);
    const deadline = Date.now() + 4000;
    for (;;) {
      try { expect(await readFile(join(dirname(host.path), "startup-ready"), "utf8")).toBe("ready"); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    // Native output was emitted before a pane existed. Allow the old lossy read path to consume it.
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = await viewer(host.path);
    first.send({ type: "input", data: "printf 'FIRST-ATTACH-%s\\n' ready\n" });
    await until(() => first.output.includes("FIRST-ATTACH-ready"));
    expect(first.output).toContain("\u001b[2J\u001b[HSTARTUP-PAINT");
    first.socket.destroy(); host.closeProof();
    const second = await viewer(host.path);
    second.send({ type: "input", data: "printf 'LATER-ATTACH-%s\\n' ready\n" });
    await until(() => second.output.includes("LATER-ATTACH-ready"));
    expect(second.output).not.toContain("STARTUP-PAINT");
    expect(host.running).toBe(true);
  });
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
  it("delivers a coalesced 48 KiB paste of valid frames to the native PTY", async () => {
    const pieces = Array.from({ length: 12 }, (_, index) => String.fromCharCode(65 + index).repeat(4096));
    const expectedBytes = 48 * 1024;
    const expectedDigest = createHash("sha256").update(pieces.join("")).digest("hex");
    const { host, pane } = await observingPty(expectedBytes);
    const wire = Buffer.from(pieces.map(data => JSON.stringify({ type: "input", data }) + "\n").join(""));
    const chunks: Buffer[] = [];
    let received = 0, delivered = 0;
    const emit = Socket.prototype.emit;
    // UDS read chunking differs by OS. Deliver these real socket bytes in a
    // single event so the regression is reproducible on either kernel.
    const coalesce = vi.spyOn(Socket.prototype, "emit").mockImplementation(function (this: Socket, event, ...args) {
      if (event !== "data" || (this as Socket & { server?: Server }).server?.address() !== host.path || delivered) {
        return Reflect.apply(emit, this, [event, ...args]);
      }
      const raw = args[0];
      if (typeof raw !== "string" && !Buffer.isBuffer(raw)) throw new Error("Unexpected UDS receive type");
      const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
      chunks.push(chunk);
      received += chunk.length;
      if (received < wire.length) return true;
      const batch = Buffer.concat(chunks);
      delivered = batch.length;
      return Reflect.apply(emit, this, [event, typeof raw === "string" ? batch.toString("utf8") : batch]);
    });
    try {
      pane.socket.write(wire);
      await until(() => pane.socket.destroyed || /PASTE-[0-9a-f]{64}/.test(pane.output));
      expect(delivered).toBe(wire.length);
      expect(pane.output).toContain(`PASTE-${expectedDigest}`);
      expect(pane.socket.destroyed).toBe(false);
      expect(host.running).toBe(true);
    } finally { coalesce.mockRestore(); }
  });
  it("accepts an exact-limit frame with a fragmented UTF-8 character", async () => {
    const data = "漢";
    const { pane } = await observingPty(Buffer.byteLength(data));
    const body = Buffer.from(JSON.stringify({ type: "input", data }));
    const frame = Buffer.concat([body, Buffer.alloc(32 * 1024 - body.length - 1, 0x20), Buffer.from("\n")]);
    const split = body.indexOf(Buffer.from(data)) + 1;
    pane.socket.write(frame.subarray(0, split));
    await new Promise<void>(resolve => setImmediate(resolve));
    pane.socket.write(frame.subarray(split));
    await until(() => pane.socket.destroyed || /PASTE-[0-9a-f]{64}/.test(pane.output));
    expect(pane.output).toContain(`PASTE-${createHash("sha256").update(data).digest("hex")}`);
    expect(pane.socket.destroyed).toBe(false);
  });
  it.each(["complete", "unfinished"])("closes the viewer for an oversized %s individual frame", async frame => {
    const host = await fixture(), pane = await viewer(host.path);
    const wire = Buffer.from(JSON.stringify({ type: "input", data: "漢".repeat(12_000) }) + (frame === "complete" ? "\n" : ""));
    pane.socket.write(wire.subarray(0, 16_384));
    pane.socket.write(wire.subarray(16_384));
    await until(() => pane.socket.destroyed);
    expect(host.running).toBe(true);
    const next = await viewer(host.path);
    next.send({ type: "input", data: "printf 'AFTER-LIMIT-%s\\n' ok\n" });
    await until(() => next.output.includes("AFTER-LIMIT-ok"));
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
