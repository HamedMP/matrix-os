// The desktop-side guard (spec 2716): only Herdr terminal calls from a Matrix
// computer reach this device's private herdr-core. Unit rows use a scripted
// folder resolver; the last suite runs the real herdr-core behind the guard.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { createDesktopLinkGuard, DESKTOP_LINK_FROM_LABEL, DesktopLinkGuardError } from "../../desktop/src/main/desktop-link/guard";

const HELLO = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } })}\n`);
const call = (id: number, method: string, params: Record<string, unknown> = {}) =>
  encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));

function decode(buffers: Buffer[]): Array<{ channel: number; kind: number; body: Record<string, unknown> | string }> {
  const decoder = new HcFrameDecoder();
  return buffers.flatMap((buffer) => decoder.push(buffer)).map((frame) => {
    const text = frame.payload.toString("utf8");
    try { return { channel: frame.channel, kind: frame.kind, body: JSON.parse(text) as Record<string, unknown> }; }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return { channel: frame.channel, kind: frame.kind, body: text };
    }
  });
}

const root = mkdtempSync("/tmp/mxg-");
const home = join(root, "home");
mkdirSync(join(home, "projects", "app"), { recursive: true });
mkdirSync(join(root, "outside"));
symlinkSync(join(root, "outside"), join(home, "escape"));

function guard() {
  return createDesktopLinkGuard({ home, computerName: "matrix-demo" });
}

async function greeted() {
  const g = guard();
  const first = await g.push(HELLO);
  expect(first.toCore).toHaveLength(1);
  return g;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Desktop link guard: handshake", () => {
  it("passes the unframed hello once, then decodes frames", async () => {
    const g = guard();
    // Split across reads, and the first call in the same read as the end of hello.
    expect((await g.push(HELLO.subarray(0, 10))).toCore).toEqual([]);
    const result = await g.push(Buffer.concat([HELLO.subarray(10), call(2, "terminal.list")]));
    expect(result.toCore[0]!.toString()).toBe(HELLO.toString());
    expect(decode(result.toCore.slice(1))).toMatchObject([{ channel: 0, body: { method: "terminal.list" } }]);
  });

  it("ends the stream on anything but a plain framed hello first", async () => {
    for (const first of [
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal.list", params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: false } })}\n`,
      // Asking to be a peer core would let this device's core call back into the computer.
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true, core: { id: "x", name: "x" } } })}\n`,
      "not json\n",
    ]) {
      await expect(guard().push(Buffer.from(first))).rejects.toBeInstanceOf(DesktopLinkGuardError);
    }
    await expect(guard().push(Buffer.alloc(70 * 1024, 0x61))).rejects.toMatchObject({ reason: "too_large" });
  });

  it("refuses a second, framed hello", async () => {
    const g = await greeted();
    const result = await g.push(call(2, "hello", { framed: true }));
    expect(result.toCore).toEqual([]);
    expect(decode(result.toComputer)).toMatchObject([{ body: { id: 2, error: { data: { kind: "denied" } } } }]);
  });
});

describe("Desktop link guard: what the computer may call", () => {
  it.each([
    ["machine.exec", { argv: ["id"] }],
    ["machine.add", { target: "box" }],
    ["machine.list", {}],
    ["file.read", { path: "/etc/hosts" }],
    ["file.write", { path: "x", content: "y" }],
    ["doc.set", { name: "x", value: 1 }],
    ["server.stop", {}],
    ["rpc.discover", {}],
    ["terminal.list", { on: "vps" }],
    ["terminal.run", { on: "vps", argv: ["sh"] }],
    ["terminal.attach", { terminal: "vps/t1", cols: 80, rows: 24 }],
    ["terminal.send", { terminal: "t1", parent: "vps/t9", text: "x" }],
    ["terminal.run", { argv: ["sh"], cwd: "/etc" }],
    ["terminal.run", { argv: ["sh"], cwd: "escape" }],
    ["terminal.run", { argv: ["sh"], cwd: "missing" }],
    ["terminal.run", { argv: ["sh"], env: { DYLD_INSERT_LIBRARIES: "/x" } }],
    ["terminal.run", { argv: Array.from({ length: 65 }, () => "a") }],
    ["terminal.label", { terminal: "t1", labels: { [DESKTOP_LINK_FROM_LABEL]: "someone-else" } }],
  ])("refuses %s %j without telling the core", async (method, params) => {
    const g = await greeted();
    const result = await g.push(call(7, method, params));
    expect(result.toCore).toEqual([]);
    expect(decode(result.toComputer)).toMatchObject([{ channel: 0, body: { id: 7, error: { data: { kind: "denied" } } } }]);
  });

  it("starts terminals at home or in a folder under it, labelled with the computer", async () => {
    const g = await greeted();
    const result = await g.push(Buffer.concat([
      call(3, "terminal.run", { argv: ["claude"], labels: { matrix: "yes", [DESKTOP_LINK_FROM_LABEL]: "forged" }, env: { TERM: "xterm-256color" } }),
      call(4, "terminal.run", { cwd: "projects/app" }),
      call(5, "terminal.run", { cwd: join(home, "projects") }),
    ]));
    expect(result.toComputer).toEqual([]);
    const sent = decode(result.toCore).map((frame) => (frame.body as { params: Record<string, unknown> }).params);
    expect(sent[0]).toEqual({
      argv: ["claude"], env: { TERM: "xterm-256color" }, cwd: realpathSync(home),
      labels: { matrix: "yes", [DESKTOP_LINK_FROM_LABEL]: "matrix-demo" },
    });
    expect(sent[1]!.cwd).toBe(realpathSync(join(home, "projects", "app")));
    expect(sent[2]!.cwd).toBe(realpathSync(join(home, "projects")));
  });

  it("passes terminal calls and channel bytes through unchanged, in order", async () => {
    const g = await greeted();
    const input = [
      call(2, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 }),
      encodeFrame(1, HC_FRAME.DATA, Buffer.from("ls\r")),
      encodeFrame(1, HC_FRAME.CREDIT, Buffer.from([0, 4, 0, 0])),
      call(3, "terminal.kill", { terminal: "t1" }),
    ];
    const result = await g.push(Buffer.concat(input));
    expect(Buffer.concat(result.toCore)).toEqual(Buffer.concat(input));
  });

  it("ends the stream on unreadable or oversized requests", async () => {
    const g = await greeted();
    await expect(g.push(encodeFrame(0, HC_FRAME.DATA, Buffer.from("{nope")))).rejects.toMatchObject({ reason: "malformed" });
    const big = await greeted();
    await expect(big.push(call(2, "terminal.send", { terminal: "t1", text: "x".repeat(300 * 1024) }))).rejects.toMatchObject({ reason: "too_large" });
  });
});

// The real herdr-core, behind the guard, as the computer would reach it.
const binary = [process.env.MATRIX_DESKTOP_HC_PATH, join(homedir(), ".local/bin/hc")].find((path) => {
  try { return !!path && existsSync(path) && /^hc 0\.1\./.test(execFileSync(path, ["--version"], { encoding: "utf8", timeout: 3_000 })); }
  catch (error: unknown) {
    // No usable hc here: these real-core cases are skipped.
    if (!(error instanceof Error)) throw error;
    return false;
  }
});

(binary ? describe : describe.skip)("Desktop link guard in front of the real herdr-core", () => {
  const core = mkdtempSync("/tmp/mxc-");
  const env = { HOME: home, PATH: "/usr/bin:/bin", HC_SESSION: "mx", XDG_STATE_HOME: join(core, "s"), XDG_CONFIG_HOME: join(core, "c"), XDG_RUNTIME_DIR: join(core, "r") };
  beforeAll(() => {
    mkdirSync(join(core, "r"), { mode: 0o700 });
    execFileSync(binary!, ["server", "start"], { env, timeout: 10_000 });
  });
  afterAll(() => {
    try { execFileSync(binary!, ["server", "stop"], { env, timeout: 5_000 }); }
    catch (error: unknown) { console.error("test core stop failed", error instanceof Error ? error.name : error); }
    rmSync(core, { recursive: true, force: true });
  });

  it("runs a terminal at home, refuses machine.exec, and the core never sees the refusal", async () => {
    const socket = connect(join(core, "r", "herdr-core", "mx.sock"));
    const g = guard();
    const replies: Array<Record<string, unknown>> = [];
    const decoder = new HcFrameDecoder();
    let handshook = false;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      let bytes = chunk;
      if (!handshook) {
        buffered = Buffer.concat([buffered, bytes]);
        const newline = buffered.indexOf(10);
        if (newline < 0) return;
        replies.push(JSON.parse(buffered.subarray(0, newline).toString()) as Record<string, unknown>);
        handshook = true;
        bytes = buffered.subarray(newline + 1);
      }
      for (const frame of decoder.push(bytes)) if (frame.channel === 0) replies.push(JSON.parse(frame.payload.toString()) as Record<string, unknown>);
    });
    const send = async (bytes: Buffer) => {
      const result = await g.push(bytes);
      for (const out of result.toCore) socket.write(out);
      return result;
    };
    const reply = async (id: number) => {
      const start = Date.now();
      while (!replies.some((entry) => entry.id === id)) {
        if (Date.now() - start > 5_000) throw new Error(`no reply ${id}: ${JSON.stringify(replies)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return replies.find((entry) => entry.id === id)!;
    };
    await send(HELLO);
    expect((await reply(1)).result).toMatchObject({ framed: true });
    const refused = await send(call(2, "machine.exec", { argv: ["id"] }));
    expect(decode(refused.toComputer)).toMatchObject([{ body: { id: 2, error: { data: { kind: "denied" } } } }]);
    await send(call(3, "terminal.run", { argv: ["sh", "-c", "pwd; sleep 5"], name: "from-matrix" }));
    const ran = (await reply(3)).result as { address: string; cwd: string; labels: Record<string, string> };
    expect(ran.cwd).toBe(realpathSync(home));
    expect(ran.labels[DESKTOP_LINK_FROM_LABEL]).toBe("matrix-demo");
    // The refused call never reached the core: no reply with id 2 came from it.
    expect(replies.filter((entry) => entry.id === 2)).toEqual([]);
    await send(call(4, "terminal.kill", { terminal: ran.address }));
    await reply(4);
    socket.destroy();
  }, 20_000);
});
