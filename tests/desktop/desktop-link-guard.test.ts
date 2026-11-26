// The desktop-side guard (spec 2716). It terminates the protocol on both sides:
// it owns the core's handshake, takes only the four Herdr terminal calls a Matrix
// computer needs, each through a strict schema and rebuilt, lets channel data
// through only on channels it saw the core open for an attach it forwarded, and
// rebuilds every answer. The last suite runs the real herdr-core behind it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { createDesktopLinkConsent, type DesktopLinkConsentRequest } from "../../desktop/src/main/desktop-link/consent";
import { createDesktopLinkGuard, DESKTOP_LINK_FROM_LABEL, DesktopLinkGuardError } from "../../desktop/src/main/desktop-link/guard";

const HELLO = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } })}\n`);
const GUARD_HELLO = HELLO.toString();
const call = (id: number, method: string, params: Record<string, unknown> = {}) =>
  encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
const reply = (id: unknown, result: unknown) => encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result })));
const helloReply = (result: Record<string, unknown> = {}, id: unknown = 1) => Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, result: {
  version: "0.1.22", generation: 1, framed: true, features: ["stream-credit"], core: { id: "c1", name: "laptop" },
  methods: ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill", "machine.exec", "terminal.send"], login_session: "x",
  ...result,
} })}\n`);
const CORE_HELLO = helloReply();

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
afterAll(() => rmSync(root, { recursive: true, force: true }));

function guard(consent?: ReturnType<typeof createDesktopLinkConsent>) {
  return createDesktopLinkGuard({ home, computerName: "matrix-demo", ...(consent ? { consent } : {}) });
}

const terminalRecord = (address: string, created: number, extra: Record<string, unknown> = {}) => ({
  address, state: "live", created_ms: created, cwd: "/home/me/secret-project", argv: ["/usr/bin/claude", "--token", "s3cret"],
  screen: "password: hunter2", labels: { "matrix.title": "Claude" }, title: null, pid: 42, ...extra,
});

/**
 * A guard with its connection to a scripted core, as the desktop link service
 * wires it. `written` is every byte the guard wrote to the core, in order;
 * `script` answers the guard's own questions. The core's handshake answer is
 * sent only when `handshake` is called (or at once, by default).
 */
async function wired(options: {
  consent?: ReturnType<typeof createDesktopLinkConsent>;
  script?: (method: string, params: Record<string, unknown>, id: number) => unknown;
  coreHello?: Buffer | null;
  computerHello?: boolean;
} = {}) {
  const g = guard(options.consent);
  const written: Buffer[] = [];
  const asked: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const toComputer: Buffer[] = [];
  const decoder = new HcFrameDecoder();
  let helloSeen = false;
  g.connect((bytes) => {
    written.push(bytes);
    let rest = bytes;
    if (!helloSeen) { helloSeen = true; return; }
    for (const frame of decoder.push(rest)) {
      if (frame.channel !== 0) continue;
      const body = JSON.parse(frame.payload.toString()) as { id: number; method: string; params: Record<string, unknown> };
      asked.push(body);
      const answer = options.script?.(body.method, body.params, body.id);
      if (answer !== undefined) queueMicrotask(() => toComputer.push(...g.fromCore(answer instanceof Buffer ? answer : reply(body.id, answer))));
    }
    rest = Buffer.alloc(0);
  });
  if (options.computerHello !== false) toComputer.push(...(await g.push(HELLO)).toComputer);
  const handshake = (bytes: Buffer = CORE_HELLO) => toComputer.push(...g.fromCore(bytes));
  if (options.coreHello !== null) handshake(options.coreHello ?? CORE_HELLO);
  return { g, written, asked, toComputer, handshake };
}

/** Settles a push, deferred calls included, into what went to the core and back to the computer. */
async function settle(result: Awaited<ReturnType<ReturnType<typeof guard>["push"]>>) {
  const later = await Promise.all(result.deferred ?? []);
  return {
    forwarded: [...result.forwarded, ...later.flatMap((item) => item.forwarded)],
    toComputer: [...result.toComputer, ...later.flatMap((item) => item.toComputer)],
  };
}

function consent(answers: boolean[] = [], fullAccess = false) {
  const asks: DesktopLinkConsentRequest[] = [];
  const c = createDesktopLinkConsent({
    ask: async (request) => { asks.push(request); return answers.shift() ?? false; },
    fullAccess: async () => fullAccess,
    dialogGapMs: 0,
    log: () => {},
  });
  return { c, asks };
}

/** The guard's call ids for what it forwarded, in order. */
const ids = (buffers: Buffer[]) => decode(buffers).map((frame) => (frame.body as { id: number }).id);

describe("Desktop link guard: the core's handshake is the guard's", () => {
  it("sends the core one fixed hello, and answers the computer's hello itself once the core confirmed framed mode", async () => {
    const g = guard();
    const written: Buffer[] = [];
    g.connect((bytes) => written.push(bytes));
    expect(written.map(String)).toEqual([GUARD_HELLO]);
    // The computer's hello, split across reads, with a call in the same read as its end.
    expect((await g.push(HELLO.subarray(0, 10))).toComputer).toEqual([]);
    const first = await g.push(Buffer.concat([HELLO.subarray(10), call(2, "terminal.list")]));
    // Nothing reaches the core before it answered the guard's hello; the call waits.
    expect(written).toHaveLength(1);
    expect(first.toComputer).toEqual([]);
    const [answer] = g.fromCore(CORE_HELLO);
    expect(JSON.parse(answer!.toString())).toEqual({ jsonrpc: "2.0", id: 1, result: {
      version: "0.1.22", generation: 1, framed: true, features: ["stream-credit"],
      methods: ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"],
    } });
    expect(decode(written.slice(1))).toMatchObject([{ channel: 0, body: { method: "terminal.list", params: {} } }]);
  });

  it.each([
    ["an error", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unsupported generation" } })}\n`)],
    ["generation 0", helloReply({ generation: 0 })],
    ["generation 2", helloReply({ generation: 2 })],
    ["unframed", helloReply({ framed: false })],
    ["another id", helloReply({}, 7)],
    ["not json", Buffer.from("hc ready\n")],
  ])("ends the stream, writing nothing more, when the core's hello answer is %s", async (_name, answer) => {
    const { g, written } = await wired({ coreHello: null });
    await g.push(call(2, "terminal.list"));
    expect(() => g.fromCore(answer)).toThrow(DesktopLinkGuardError);
    expect(written.map(String)).toEqual([GUARD_HELLO]);
  });

  // Fault detected (review, P0): the computer's own hello reached the core, so a hello
  // with generation 0 left the core in unframed line mode, and a later channel frame
  // carrying a raw JSON-RPC line ran there unchecked.
  it.each([
    ["generation 0", { framed: true, generation: 0 }],
    ["generation 1", { framed: true, generation: 1 }],
    ["features", { framed: true, features: ["x"] }],
    ["not framed", { framed: false }],
    ["a peer core", { framed: true, core: { id: "x", name: "x" } }],
    ["calls you", { framed: true, calls_you: true }],
  ])("ends the stream on a computer hello with %s, and the core sees only the guard's hello", async (_name, params) => {
    const { g, written } = await wired({ computerHello: false });
    const smuggled = Buffer.concat([
      Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params })}\n`),
      encodeFrame(5, HC_FRAME.DATA, Buffer.from(`\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "terminal.run", params: { line: "id" } })}\n`)),
    ]);
    await expect(g.push(smuggled)).rejects.toBeInstanceOf(DesktopLinkGuardError);
    expect(written.map(String)).toEqual([GUARD_HELLO]);
  });

  it("ends the stream on an unframed JSON line, or anything but hello, first", async () => {
    for (const first of [
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal.run", params: { line: "id" } })}\n`,
      "not json\n",
    ]) {
      const { g, written } = await wired({ computerHello: false });
      await expect(g.push(Buffer.from(first))).rejects.toBeInstanceOf(DesktopLinkGuardError);
      expect(written.map(String)).toEqual([GUARD_HELLO]);
    }
    await expect(guard().push(Buffer.alloc(70 * 1024, 0x61))).rejects.toMatchObject({ reason: "too_large" });
  });

  // Fault detected (review, P0): the guard's own question went to the core ahead of the
  // handshake, so the core read a frame as its first line and stayed unframed.
  it("holds an attach sent with the hello, and its own question about it, until the core confirmed framed mode", async () => {
    const { c } = consent([true]);
    const { g, written, handshake } = await wired({
      consent: c, coreHello: null, computerHello: false,
      script: (method) => (method === "terminal.list" ? { terminals: [terminalRecord("t1", 1)] } : undefined),
    });
    const pushed = await g.push(Buffer.concat([HELLO, call(2, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 })]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(written.map(String)).toEqual([GUARD_HELLO]);
    handshake();
    const decided = await settle(pushed);
    expect(written[0]!.toString()).toBe(GUARD_HELLO);
    expect(decode(written.slice(1)).map((frame) => (frame.body as { method: string }).method)).toEqual(["terminal.list", "terminal.list", "terminal.attach"]);
    expect(decided.forwarded).toHaveLength(1);
  });

  it("refuses a second, framed hello", async () => {
    const { g, written } = await wired();
    const result = await g.push(call(2, "hello", { framed: true }));
    expect(written).toHaveLength(1);
    expect(decode(result.toComputer)).toMatchObject([{ body: { id: 2, error: { data: { kind: "denied" } } } }]);
  });
});

describe("Desktop link guard: channels", () => {
  /** A guard with one attach forwarded and answered with `channel`. */
  async function attached(channel: number) {
    const link = await wired();
    const [sent] = ids((await link.g.push(call(2, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 }))).forwarded);
    link.g.fromCore(reply(sent, { channel, resize_notifications: false, automatic_input: false }));
    return link;
  }

  it("passes typing, credit, size and close on a channel the core opened for a forwarded attach", async () => {
    const { g, written } = await attached(3);
    const before = written.length;
    const input = [encodeFrame(3, HC_FRAME.DATA, Buffer.from("ls\r")), encodeFrame(3, HC_FRAME.CREDIT, Buffer.from([0, 4, 0, 0])), encodeFrame(3, HC_FRAME.CLOSE, Buffer.alloc(0))];
    await g.push(Buffer.concat(input));
    expect(Buffer.concat(written.slice(before))).toEqual(Buffer.concat(input));
    // Closed: anything more on it is dropped.
    const closedAt = written.length;
    await g.push(encodeFrame(3, HC_FRAME.DATA, Buffer.from("x")));
    expect(written).toHaveLength(closedAt);
  });

  it("ends the stream on a frame for a channel never opened, or one the core opened for nobody", async () => {
    const { g, written } = await attached(3);
    const before = written.length;
    await expect(g.push(encodeFrame(4, HC_FRAME.DATA, Buffer.from("id\n")))).rejects.toMatchObject({ reason: "channel" });
    expect(written).toHaveLength(before);
    const other = await wired();
    await expect(other.g.push(encodeFrame(1, HC_FRAME.DATA, Buffer.from("x")))).rejects.toMatchObject({ reason: "channel" });
    await expect((await attached(3)).g.push(encodeFrame(3, HC_FRAME.FOCUS, Buffer.alloc(0)))).rejects.toMatchObject({ reason: "channel" });
  });

  it("opens no channel for a refused or failed attach, and never twice", async () => {
    const { g } = await wired();
    const [sent] = ids((await g.push(call(2, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 }))).forwarded);
    g.fromCore(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: sent, error: { code: -1, data: { kind: "not_found" } } }))));
    await expect(g.push(encodeFrame(1, HC_FRAME.DATA, Buffer.from("x")))).rejects.toMatchObject({ reason: "channel" });
    const twice = await attached(3);
    const [again] = ids((await twice.g.push(call(3, "terminal.attach", { terminal: "t2", cols: 80, rows: 24 }))).forwarded);
    expect(decode(twice.g.fromCore(reply(again, { channel: 3 })))[0]!.body).toMatchObject({ id: 3, error: { data: { kind: "failed" } } });
  });

  // Fault detected (review, P2): a credit the client sent as it read a terminal's last
  // output arrived after the core closed the channel, and the whole link hung up.
  it("drops a late frame for a channel the core just closed, without ending the stream", async () => {
    const { g, written } = await attached(3);
    g.fromCore(encodeFrame(3, HC_FRAME.CLOSE, Buffer.alloc(0)));
    const before = written.length;
    await g.push(Buffer.concat([encodeFrame(3, HC_FRAME.CREDIT, Buffer.from([0, 4, 0, 0])), encodeFrame(3, HC_FRAME.DATA, Buffer.from("x"))]));
    expect(written).toHaveLength(before);
    await expect(g.push(encodeFrame(4, HC_FRAME.DATA, Buffer.from("x")))).rejects.toMatchObject({ reason: "channel" });
  });

  it("rebuilds credit, size and close from their fields, and ends the stream on a size out of bounds", async () => {
    const { g, written } = await attached(3);
    const resize = (cols: number, rows: number) => { const payload = Buffer.alloc(4); payload.writeUInt16LE(cols, 0); payload.writeUInt16LE(rows, 2); return encodeFrame(3, HC_FRAME.RESIZE, payload); };
    const before = written.length;
    await g.push(Buffer.concat([resize(120, 40), encodeFrame(3, HC_FRAME.CLOSE, Buffer.from("junk"))]));
    expect(Buffer.concat(written.slice(before))).toEqual(Buffer.concat([resize(120, 40), encodeFrame(3, HC_FRAME.CLOSE, Buffer.alloc(0))]));
    await expect((await attached(3)).g.push(resize(65535, 65535))).rejects.toMatchObject({ reason: "malformed" });
    await expect((await attached(3)).g.push(resize(0, 24))).rejects.toMatchObject({ reason: "malformed" });
    await expect((await attached(3)).g.push(encodeFrame(3, HC_FRAME.CREDIT, Buffer.from([1, 2])))).rejects.toMatchObject({ reason: "malformed" });
  });

  it("refuses a control frame over its cap as soon as the header arrives", async () => {
    const { g } = await wired();
    const header = encodeFrame(0, HC_FRAME.DATA, Buffer.alloc(300 * 1024)).subarray(0, 9);
    await expect(g.push(header)).rejects.toMatchObject({ reason: "too_large" });
  });

  it("keeps the core's bytes for channels it did not give the computer", async () => {
    const { g } = await attached(3);
    expect(g.fromCore(encodeFrame(9, HC_FRAME.DATA, Buffer.from("other")))).toEqual([]);
    expect(g.fromCore(encodeFrame(3, HC_FRAME.DATA, Buffer.from("mine")))).toHaveLength(1);
  });
});

describe("Desktop link guard: deny by default", () => {
  it.each([
    "machine.exec", "machine.add", "machine.list", "file.read", "file.write", "doc.set", "doc.subscribe", "server.stop",
    "rpc.discover", "templates.list", "events.subscribe", "terminal.get", "terminal.read", "terminal.wait", "terminal.send",
    "terminal.keys", "terminal.interrupt", "terminal.rm", "terminal.label", "terminal.put", "terminal.put_begin",
    "terminal.put_chunk", "terminal.put_finish", "terminal.put_abort", "terminal.resize", "hello",
  ])("refuses %s without telling the core", async (method) => {
    const { g, written } = await wired();
    const result = await g.push(call(7, method, { terminal: "t1", argv: ["id"], path: "/etc/hosts", id: 1, data: "eA==" }));
    expect(written).toHaveLength(1);
    expect(decode(result.toComputer)).toMatchObject([{ channel: 0, body: { id: 7, error: { data: { kind: "denied" } } } }]);
  });

  // Each of the four allowed calls, valid as the computer sends it, then with one more parameter.
  const valid: Array<[string, Record<string, unknown>]> = [
    ["terminal.list", {}],
    ["terminal.run", { argv: ["sh"], size: { cols: 80, rows: 24 }, env: { TERM: "xterm-256color" }, no_parent: true, no_notify: true, wait: false }],
    ["terminal.attach", { terminal: "t1", cols: 80, rows: 24, history: 2000, observe: true }],
    ["terminal.kill", { terminal: "t1" }],
  ];
  const extras: Array<Record<string, unknown>> = [
    { keep: true }, { caller: "t2" }, { parent: "t2" }, { on: "vps" }, { labels: { a: "b" } }, { all: true },
    { die_with_parent: true }, { outlive_parent: true }, { rm: true }, { display: {} }, { timeout: 1 }, { resumed: true },
    { resize_notifications: true }, { unknown_param: 1 }, JSON.parse('{"__proto__":{"keep":true}}') as Record<string, unknown>,
  ];
  it.each(valid.flatMap(([method, params]) => extras.map((extra) => [method, params, extra] as const)))(
    "refuses %s with an extra parameter %j",
    async (method, params, extra) => {
      const { g, written } = await wired();
      expect(JSON.stringify({ ...params, ...extra }).length).toBeGreaterThan(JSON.stringify(params).length);
      const result = await g.push(call(7, method, { ...params, ...extra }));
      expect(written).toHaveLength(1);
      expect(decode(result.toComputer)).toMatchObject([{ body: { id: 7, error: { data: { kind: "denied" } } } }]);
    },
  );

  it("refuses a nested extra field and an extra field on the call itself", async () => {
    const { g, written } = await wired();
    await g.push(call(7, "terminal.run", { argv: ["sh"], size: { cols: 80, rows: 24, x: 1 } }));
    const top = await g.push(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "terminal.list", params: {}, on: "vps" }))));
    expect(written).toHaveLength(1);
    expect(decode(top.toComputer)).toMatchObject([{ body: { id: 8, error: { data: { kind: "denied" } } } }]);
  });

  it.each([
    ["terminal.run", { argv: ["sh"], line: "id" }],
    ["terminal.run", { argv: ["sh"], cwd: "/etc" }],
    ["terminal.run", { argv: ["sh"], cwd: "escape" }],
    ["terminal.run", { argv: ["sh"], cwd: "missing" }],
    ["terminal.run", { argv: ["sh"], env: { DYLD_INSERT_LIBRARIES: "/x" } }],
    ["terminal.run", { argv: ["sh"], env: { LC_ALL: "C; rm -rf ~" } }],
    ["terminal.run", { argv: Array.from({ length: 65 }, () => "a") }],
    ["terminal.run", { argv: [] }],
    ["terminal.run", { name: "Has Spaces" }],
    ["terminal.run", { name: "t12" }],
    ["terminal.run", { no_parent: false }],
    ["terminal.attach", { terminal: "vps/t1", cols: 80, rows: 24 }],
    ["terminal.attach", { terminal: "my-name", cols: 80, rows: 24 }],
    ["terminal.attach", { terminal: "t1" }],
    ["terminal.kill", { terminal: "mac/t1" }],
  ])("refuses %s %j", async (method, params) => {
    const { g, written } = await wired();
    const result = await settle(await g.push(call(7, method, params)));
    expect(written).toHaveLength(1);
    expect(decode(result.toComputer)).toMatchObject([{ body: { id: 7, error: { data: { kind: "denied" } } } }]);
  });

  it("answers malformed calls that name an id and drops notifications, replies and batches", async () => {
    const { g, written } = await wired();
    const frames = [
      { jsonrpc: "2.0", method: "terminal.run", params: { argv: ["sh"] } },
      { jsonrpc: "2.0", id: 4, result: { ok: true } },
      [{ jsonrpc: "2.0", id: 5, method: "terminal.run", params: {} }],
      { jsonrpc: "1.0", id: 6, method: "terminal.list", params: {} },
    ].map((body) => encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify(body))));
    const result = await g.push(Buffer.concat(frames));
    expect(written).toHaveLength(1);
    expect(decode(result.toComputer)).toMatchObject([{ body: { id: 4 } }, { body: { id: 6, error: { data: { kind: "denied" } } } }]);
  });

  it("ends the stream on unreadable or oversized requests", async () => {
    const { g } = await wired();
    await expect(g.push(encodeFrame(0, HC_FRAME.DATA, Buffer.from("{nope")))).rejects.toMatchObject({ reason: "malformed" });
    const big = await wired();
    await expect(big.g.push(call(2, "terminal.run", { line: "x".repeat(300 * 1024) }))).rejects.toMatchObject({ reason: "too_large" });
  });

  it("ends the stream when more than it holds waits for the core's handshake", async () => {
    const { g } = await wired({ coreHello: null });
    const calls = Array.from({ length: 200 }, (_, index) => call(index + 2, "terminal.run", { line: "x".repeat(8 * 1024) }));
    await expect(g.push(Buffer.concat(calls))).rejects.toMatchObject({ reason: "too_large" });
  });
});

describe("Desktop link guard: what reaches the core", () => {
  it("rebuilds a start: home or a folder under it, its own label, never kept, parented or reporting", async () => {
    const { g, written } = await wired();
    const result = await g.push(Buffer.concat([
      call(3, "terminal.run", { argv: ["claude"], env: { TERM: "xterm-256color" }, size: { cols: 80, rows: 24 }, no_parent: true, no_notify: true, wait: false }),
      call(4, "terminal.run", { cwd: "projects/app" }),
      call(5, "terminal.run", { cwd: join(home, "projects"), line: "make test" }),
    ]));
    expect(result.toComputer).toEqual([]);
    expect(Buffer.concat(written.slice(1))).toEqual(Buffer.concat(result.forwarded));
    const sent = decode(result.forwarded).map((frame) => frame.body as { id: number; params: Record<string, unknown> });
    const fixed = { labels: { [DESKTOP_LINK_FROM_LABEL]: "matrix-demo" }, keep: false, no_parent: true, no_notify: true, wait: false };
    expect(sent[0]!.params).toEqual({ argv: ["claude"], env: { TERM: "xterm-256color" }, size: { cols: 80, rows: 24 }, cwd: realpathSync(home), ...fixed });
    expect(sent[1]!.params).toEqual({ cwd: realpathSync(join(home, "projects", "app")), ...fixed });
    expect(sent[2]!.params).toEqual({ line: "make test", cwd: realpathSync(join(home, "projects")), ...fixed });
  });

  it("sends every call under an id of its own and answers with the caller's", async () => {
    const { g } = await wired();
    // The same id twice, and the id the guard's own hello used.
    const sent = ids((await g.push(Buffer.concat([call(1, "terminal.list"), call(1, "terminal.list"), call(9, "terminal.list")]))).forwarded);
    expect(new Set([...sent, 1]).size).toBe(4);
    const answers = decode(g.fromCore(Buffer.concat([reply(sent[2], { terminals: [] }), reply(sent[0], { terminals: [] }), reply(sent[1], { terminals: [] })])));
    expect(answers.map((frame) => (frame.body as { id: number }).id)).toEqual([9, 1, 1]);
    // An answer the guard did not ask for, or a second one, never reaches the computer.
    expect(g.fromCore(reply(sent[0], { terminals: [] }))).toEqual([]);
    expect(g.fromCore(reply(999, { terminals: [] }))).toEqual([]);
  });
});

describe("Desktop link guard: what reaches the computer", () => {
  async function answered(method: string, params: Record<string, unknown>, result: unknown) {
    const { g } = await wired();
    const [sent] = ids((await settle(await g.push(call(5, method, params)))).forwarded);
    return decode(g.fromCore(reply(sent, result)))[0]!.body as { id: number; result: Record<string, unknown> };
  }

  it("lists this device's terminals by address, state, title and status only", async () => {
    const answer = await answered("terminal.list", {}, {
      terminals: [
        terminalRecord("t1", 100, { status: { state: "working", msg: "thinking", extra: "x" } }),
        terminalRecord("vps/t2", 101),
        { address: "t3", state: "live" },
      ],
      hidden_finished: 2, machines: [{ name: "vps", address: "10.0.0.2" }],
    });
    expect(answer).toEqual({ jsonrpc: "2.0", id: 5, result: {
      terminals: [
        { address: "t1", state: "live", title: "Claude", status: { state: "working", msg: "thinking" } },
        { address: "t3", state: "live", title: "Terminal" },
      ],
      hidden_finished: 0, machines: [],
    } });
  });

  it("answers a start with the terminal's address, and an attach with its channel, nothing else", async () => {
    expect(await answered("terminal.run", {}, terminalRecord("t4", 100))).toEqual({ jsonrpc: "2.0", id: 5, result: { address: "t4", state: "live" } });
    expect(await answered("terminal.attach", { terminal: "t4", cols: 80, rows: 24 }, {
      channel: 3, resize_notifications: false, automatic_input: false, terminal: terminalRecord("t4", 100),
    })).toEqual({ jsonrpc: "2.0", id: 5, result: { channel: 3, resize_notifications: false, automatic_input: false } });
  });

  it("passes a core failure's kind but not its message or details", async () => {
    const { g } = await wired();
    const [sent] = ids((await g.push(call(5, "terminal.list"))).forwarded);
    const failed = encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: sent,
      error: { code: -32010, message: "/home/me/secret: denied", data: { kind: "not_found", path: "/home/me/secret" } } })));
    expect(decode(g.fromCore(failed))[0]!.body).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32010, message: "terminal call failed", data: { kind: "not_found" } } });
  });

  it("keeps the core's own notifications on the control channel", async () => {
    const { g } = await wired();
    const note = encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "terminal.changed", params: terminalRecord("t1", 1) })));
    expect(g.fromCore(note)).toEqual([]);
  });

  it("ends the stream when the core's framing breaks", async () => {
    const { g } = await wired();
    expect(() => g.fromCore(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(DesktopLinkGuardError);
  });
});

describe("Desktop link guard: the owner's consent", () => {
  const list = (...terminals: unknown[]) => ({ terminals, hidden_finished: 0, machines: [] });
  const noTemplates = (method: string) => (method === "templates.list" ? { templates: [] } : undefined);

  it("shows the exact command, quoted, and the folder; refuses one too long to show in full", async () => {
    const { c, asks } = consent([true, true]);
    const { g } = await wired({ consent: c, script: noTemplates });
    await settle(await g.push(call(3, "terminal.run", { argv: ["sh", "-c", "echo hi; rm -rf ~/x", "it's"], cwd: "projects/app" })));
    await settle(await g.push(call(4, "terminal.run", { line: "echo a\nreboot‮​" })));
    expect(asks).toEqual([
      { kind: "run", command: `sh -c 'echo hi; rm -rf ~/x' 'it'\\''s'`, cwd: realpathSync(join(home, "projects", "app")) },
      { kind: "run", command: "echo a⟨U+000A⟩reboot⟨U+202E⟩⟨U+200B⟩", cwd: realpathSync(home) },
    ]);
    const long = await settle(await g.push(call(5, "terminal.run", { line: "x".repeat(501) })));
    expect(long.forwarded).toEqual([]);
    expect(asks).toHaveLength(2);
  });

  // Fault detected (review, P1): a program named like a template, in another letter case
  // or by a path, ran the template's own command while the dialog showed the name.
  it.each([["reviewer"], ["Reviewer"], ["REVIEWER.md"], ["./reviewer"], ["templates/reviewer"], ["..\\reviewer"]])(
    "refuses a start whose program %s could name a template, without asking",
    async (program) => {
      const { c, asks } = consent([true]);
      const { g } = await wired({ consent: c, script: (method) => (method === "templates.list" ? { templates: [{ name: "reviewer", command: "claude --yolo" }] } : undefined) });
      expect((await settle(await g.push(call(3, "terminal.run", { argv: [program, "fix it"] })))).forwarded).toEqual([]);
      expect(asks).toEqual([]);
    },
  );

  it("refuses a start when the core cannot say whether its program is a template", async () => {
    const { c, asks } = consent([true]);
    const silent = guard(c);
    await silent.push(HELLO);
    // Never connected to a core: nothing can be asked, so nothing starts.
    expect((await settle(await silent.push(call(4, "terminal.run", { argv: ["claude"] })))).forwarded).toEqual([]);
    expect(asks).toEqual([]);
  });

  it("starts a program on a core without templates, and an absolute path", async () => {
    const { c } = consent([true, true]);
    const { g } = await wired({ consent: c, script: (method, _params, id) => (method === "templates.list"
      ? encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, data: { kind: "method_not_found" } } })))
      : undefined) });
    expect((await settle(await g.push(call(3, "terminal.run", { argv: ["claude"] })))).forwarded).toHaveLength(1);
    expect((await settle(await g.push(call(4, "terminal.run", { argv: ["/opt/bin/reviewer"] })))).forwarded).toHaveLength(1);
  });

  it("asks once for a terminal it did not start, naming its address, program, folder and title, then covers that one terminal", async () => {
    const { c, asks } = consent([true]);
    const { g } = await wired({ consent: c, script: (method) => (method === "terminal.list"
      ? list(terminalRecord("t7", 100, { labels: { "matrix.title": "deploy\u001b[2Jprod" } })) : undefined) });
    const first = await settle(await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 })));
    expect(decode(first.forwarded)[0]!.body).toMatchObject({ method: "terminal.attach", params: { terminal: "t7", cols: 80, rows: 24 } });
    expect(asks).toEqual([{
      kind: "terminal", action: "open", terminal: "t7", title: "deploy[2Jprod", program: "/usr/bin/claude --token s3cret", cwd: "/home/me/secret-project",
    }]);
    await settle(await g.push(call(4, "terminal.kill", { terminal: "t7" })));
    expect(asks).toHaveLength(1);
  });

  it("refuses a terminal the core does not list as live", async () => {
    const { c, asks } = consent([true]);
    const { g } = await wired({ consent: c, script: (method) => (method === "terminal.list" ? list(terminalRecord("t7", 100, { state: "finished" })) : undefined) });
    expect((await settle(await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 })))).forwarded).toEqual([]);
    expect(asks).toEqual([]);
  });

  it("asks every time for a terminal the core gives no start time, since a later one could take its address", async () => {
    const { c, asks } = consent([true, true]);
    const { g } = await wired({ consent: c, script: (method) => (method === "terminal.list" ? list({ address: "t7", state: "live" }) : undefined) });
    for (const id of [3, 4]) expect((await settle(await g.push(call(id, "terminal.kill", { terminal: "t7" })))).forwarded).toHaveLength(1);
    expect(asks).toHaveLength(2);
  });

  it("refuses an approved terminal that became another one while the owner answered", async () => {
    let created = 100;
    const asks: string[] = [];
    const c = createDesktopLinkConsent({ ask: async () => { asks.push("terminal"); created = 200; return true; }, fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    const { g } = await wired({ consent: c, script: (method) => (method === "terminal.list" ? list(terminalRecord("t7", created)) : undefined) });
    expect((await settle(await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 })))).forwarded).toEqual([]);
    expect(asks).toHaveLength(1);
  });

  // Fault detected: a paired, linked desktop let its computer start programs and read
  // every terminal without the owner seeing anything (2698's consent model).
  it("never lets a declined start or terminal reach the core", async () => {
    const { c, asks } = consent([false, false]);
    const { g, written } = await wired({ consent: c, script: (method) => (method === "templates.list" ? { templates: [] } : method === "terminal.list" ? list(terminalRecord("t7", 1)) : undefined) });
    const result = await settle(await g.push(Buffer.concat([call(2, "terminal.run", { argv: ["uname", "-a"] }), call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 })])));
    expect(result.forwarded).toEqual([]);
    expect(decode(written.slice(1)).map((frame) => (frame.body as { method: string }).method)).not.toContain("terminal.run");
    expect(asks.map((ask) => ask.kind).sort()).toEqual(["run", "terminal"]);
    expect(result.toComputer).toHaveLength(2);
  });

  // Fault detected (review): waiting for the owner held every later call on the stream.
  it("keeps the rest of the stream moving while a call waits for the owner", async () => {
    let allow: ((answer: boolean) => void) | undefined;
    const c = createDesktopLinkConsent({ ask: () => new Promise<boolean>((resolve) => { allow = resolve; }), fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    const { g } = await wired({ consent: c, script: noTemplates });
    const result = await g.push(Buffer.concat([call(2, "terminal.run", { argv: ["claude"] }), call(4, "terminal.list")]));
    expect(decode(result.forwarded).map((frame) => (frame.body as { method: string }).method)).toEqual(["terminal.list"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    allow!(true);
    expect(decode((await result.deferred![0]!).forwarded).map((frame) => (frame.body as { method: string }).method)).toEqual(["terminal.run"]);
  });

  // Fault detected (review): the guard approved one terminal but never checked that the
  // core attached that one.
  it("refuses an attach the core answered with another terminal than the one approved, and closes that viewer", async () => {
    const { c } = consent([true]);
    const { g, written } = await wired({ consent: c, script: (method) => (method === "terminal.list" ? list(terminalRecord("t7", 100)) : undefined) });
    const [sent] = ids((await settle(await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 })))).forwarded);
    const before = written.length;
    const answer = decode(g.fromCore(reply(sent, { channel: 4, terminal: terminalRecord("t7", 999) })));
    expect(answer[0]!.body).toMatchObject({ id: 3, error: { data: { kind: "failed" } } });
    expect(written.slice(before)).toEqual([encodeFrame(4, HC_FRAME.CLOSE, Buffer.alloc(0))]);
    await expect(g.push(encodeFrame(4, HC_FRAME.DATA, Buffer.from("x")))).rejects.toMatchObject({ reason: "channel" });
  });

  it("closes the owner's dialog when the stream ends, and forwards nothing after", async () => {
    let seen: AbortSignal | null = null;
    const c = createDesktopLinkConsent({ ask: (_request, signal) => { seen = signal; return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)); }, fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    const { g, written } = await wired({ consent: c, script: noTemplates });
    const pushed = await g.push(call(3, "terminal.run", { argv: ["claude"] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = written.length;
    g.close();
    expect(seen!.aborted).toBe(true);
    expect((await settle(pushed)).forwarded).toEqual([]);
    expect(written).toHaveLength(before);
  });

  it("refuses on Windows a batch file whose arguments cmd.exe would read as commands", async () => {
    const { c, asks } = consent([true, true, true]);
    const g = createDesktopLinkGuard({ home: "C:\\Users\\me", computerName: "matrix-demo", platform: "win32", resolveFolder: async (folder) => folder,
      pathApi: (await import("node:path")).win32, consent: c });
    const written: Buffer[] = [];
    const decoder = new HcFrameDecoder();
    let greeted = false;
    g.connect((bytes) => {
      written.push(bytes);
      if (!greeted) { greeted = true; return; }
      for (const frame of decoder.push(bytes)) {
        const body = JSON.parse(frame.payload.toString()) as { id: number; method: string };
        if (body.method === "templates.list") queueMicrotask(() => g.fromCore(reply(body.id, { templates: [] })));
      }
    });
    await g.push(HELLO);
    g.fromCore(CORE_HELLO);
    expect((await settle(await g.push(call(3, "terminal.run", { argv: ["build.cmd", '""&calc'] })))).forwarded).toEqual([]);
    expect((await settle(await g.push(call(4, "terminal.run", { argv: ["C:\\tools\\run.BAT", "a|b"] })))).forwarded).toEqual([]);
    // Windows drops a trailing dot or space, and reads a stream suffix: these still run the batch file.
    for (const [index, argv] of [["npm.cmd.", '"&calc.exe'], ["x.bat ", "a&b"], ["x.bat::$DATA", "a&b"], ["calc.bat&x.bat"], ['C:\\x"y.exe'], ["C:calc.exe"]].entries()) {
      expect((await settle(await g.push(call(10 + index, "terminal.run", { argv })))).forwarded).toEqual([]);
    }
    expect(asks).toEqual([]);
    expect((await settle(await g.push(call(5, "terminal.run", { argv: ["build.cmd", "release"] })))).forwarded).toHaveLength(1);
    // A program cmd.exe never reads may have its own characters in its path.
    expect((await settle(await g.push(call(6, "terminal.run", { argv: ["C:\\Program Files (x86)\\Git\\bin\\git.exe", "log", "--format=%h"] })))).forwarded).toHaveLength(1);
  });

  it("refuses an attach answered with another terminal than the one named, even when nothing was approved", async () => {
    const { g } = await wired();
    const [sent] = ids((await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 }))).forwarded);
    expect(decode(g.fromCore(reply(sent, { channel: 4, terminal: terminalRecord("t8", 1) })))[0]!.body).toMatchObject({ id: 3, error: { data: { kind: "failed" } } });
  });

  // Fault detected (review): an attach answered after its deadline left the core's viewer open.
  it("closes the viewer of an attach the core answers after the guard gave up on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { g, written } = await wired();
      const [sent] = ids((await g.push(call(3, "terminal.attach", { terminal: "t7", cols: 80, rows: 24 }))).forwarded);
      vi.advanceTimersByTime(120_001);
      const before = written.length;
      expect(g.fromCore(reply(sent, { channel: 6, terminal: terminalRecord("t7", 1) }))).toEqual([]);
      expect(written.slice(before)).toEqual([encodeFrame(6, HC_FRAME.CLOSE, Buffer.alloc(0))]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fault detected (review): every start began its folder check before any limit, so a
  // computer could keep thousands of checks and their promises waiting.
  it("refuses a call before any work starts once sixteen are being decided", async () => {
    const c = createDesktopLinkConsent({ ask: () => new Promise<boolean>(() => {}), fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    const { g } = await wired({ consent: c, script: noTemplates });
    const pushed = await g.push(Buffer.concat(Array.from({ length: 17 }, (_, index) => call(index + 2, "terminal.run", { argv: ["claude"] }))));
    expect(pushed.deferred).toHaveLength(16);
    expect(decode(pushed.toComputer)).toMatchObject([{ body: { id: 18, error: { data: { kind: "denied" } } } }]);
  });

  it("covers the terminal a start made, but not a new terminal the core later gives the same address", async () => {
    const { c, asks } = consent([true, false]);
    let created = 100;
    const { g } = await wired({ consent: c, script: (method) => {
      if (method === "templates.list") return { templates: [] };
      if (method === "terminal.list") return list(terminalRecord("t1", created));
      return undefined;
    } });
    const [started] = ids((await settle(await g.push(call(3, "terminal.run", { argv: ["claude"] })))).forwarded);
    g.fromCore(reply(started, terminalRecord("t1", 100)));
    expect(asks).toHaveLength(1);
    expect((await settle(await g.push(call(4, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 })))).forwarded).toHaveLength(1);
    expect(asks).toHaveLength(1);
    // The core restarted: t1 is another terminal now, and the owner is asked again.
    created = 200;
    expect((await settle(await g.push(call(5, "terminal.attach", { terminal: "t1", cols: 80, rows: 24 })))).forwarded).toEqual([]);
    expect(asks).toHaveLength(2);
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
    // What the computer receives (through the guard), and what the core itself said (for checks only).
    const toComputer: Array<Record<string, unknown>> = [];
    const raw: Array<Record<string, unknown>> = [];
    const computerDecoder = new HcFrameDecoder();
    const rawDecoder = new HcFrameDecoder();
    let handshook = false;
    let computerHello = false;
    socket.on("data", (chunk: Buffer) => {
      for (const out of g.fromCore(chunk)) {
        if (!computerHello) { toComputer.push(JSON.parse(out.toString()) as Record<string, unknown>); computerHello = true; continue; }
        for (const frame of computerDecoder.push(out)) if (frame.channel === 0) toComputer.push(JSON.parse(frame.payload.toString()) as Record<string, unknown>);
      }
      let bytes = chunk;
      if (!handshook) {
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        handshook = true;
        bytes = bytes.subarray(newline + 1);
      }
      for (const frame of rawDecoder.push(bytes)) if (frame.channel === 0) raw.push(JSON.parse(frame.payload.toString()) as Record<string, unknown>);
    });
    // The guard alone writes to the core, starting with its own handshake.
    g.connect((bytes) => socket.write(bytes));
    const send = (bytes: Buffer) => g.push(bytes);
    const waitFor = async (from: Array<Record<string, unknown>>, id: number) => {
      const start = Date.now();
      while (!from.some((entry) => entry.id === id)) {
        if (Date.now() - start > 5_000) throw new Error(`no reply ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return from.find((entry) => entry.id === id)!;
    };
    await send(HELLO);
    const hello = (await waitFor(toComputer, 1)).result as { methods: string[] };
    expect(hello.methods.sort()).toEqual(["terminal.attach", "terminal.kill", "terminal.list", "terminal.run"]);
    const refused = await send(call(2, "machine.exec", { argv: ["id"] }));
    expect(decode(refused.toComputer)).toMatchObject([{ body: { id: 2, error: { data: { kind: "denied" } } } }]);
    await send(call(3, "terminal.run", { argv: ["sh", "-c", "pwd; sleep 5"], name: "from-matrix" }));
    const ran = (await waitFor(toComputer, 3)).result as { address: string };
    expect(Object.keys(ran).sort()).toEqual(["address", "state"]);
    // What the core itself recorded: started at home, labelled, never kept.
    socket.write(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 9000, method: "terminal.get", params: { terminal: ran.address } }))));
    const record = (await waitFor(raw, 9000)).result as { cwd: string; keep: boolean; labels: Record<string, string> };
    expect(record.cwd).toBe(realpathSync(home));
    expect(record.keep).toBe(false);
    expect(record.labels[DESKTOP_LINK_FROM_LABEL]).toBe("matrix-demo");
    // The refused call never reached the core, and the core's own answer never reached the computer.
    expect(raw.some((entry) => (entry.error as { data?: { kind?: string } } | undefined)?.data?.kind === "denied")).toBe(false);
    expect(toComputer.some((entry) => entry.id === 9000)).toBe(false);
    await send(call(4, "terminal.kill", { terminal: ran.address }));
    await waitFor(toComputer, 4);
    socket.destroy();
  }, 20_000);

  // Fault detected (review, P1): the guard checks an attach against the approved terminal's
  // record, so a core whose attach answer lacked it would refuse every approved attach.
  it("attaches to an approved terminal on the real core", async () => {
    const socket = connect(join(core, "r", "herdr-core", "mx.sock"));
    const asks: string[] = [];
    const consent = createDesktopLinkConsent({ ask: async (request) => { asks.push(request.kind); return true; }, fullAccess: async () => false, dialogGapMs: 0, log: () => {} });
    const g = createDesktopLinkGuard({ home, computerName: "matrix-demo", consent });
    const answers: Array<Record<string, unknown>> = [];
    const decoder = new HcFrameDecoder();
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      for (const out of g.fromCore(chunk)) {
        if (!greeted) { greeted = true; continue; }
        for (const frame of decoder.push(out)) if (frame.channel === 0) answers.push(JSON.parse(frame.payload.toString()) as Record<string, unknown>);
      }
    });
    g.connect((bytes) => socket.write(bytes));
    const send = async (bytes: Buffer) => {
      const result = await g.push(bytes);
      for (const later of await Promise.all(result.deferred ?? [])) void later;
      for (const answer of result.toComputer) { if (greeted) for (const frame of decoder.push(answer)) answers.push(JSON.parse(frame.payload.toString()) as Record<string, unknown>); else greeted = true; }
    };
    const waitFor = async (id: number) => {
      const start = Date.now();
      while (!answers.some((entry) => entry.id === id)) {
        if (Date.now() - start > 5_000) throw new Error(`no answer ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return answers.find((entry) => entry.id === id)!;
    };
    await send(HELLO);
    await send(call(3, "terminal.run", { line: "sleep 20", name: "approved" }));
    const { address } = (await waitFor(3)).result as { address: string };
    await send(call(4, "terminal.attach", { terminal: address, cols: 80, rows: 24 }));
    expect((await waitFor(4)).result).toMatchObject({ channel: expect.any(Number) });
    await send(call(5, "terminal.kill", { terminal: address }));
    await waitFor(5);
    expect(asks).toEqual(["run"]);
    socket.destroy();
  }, 20_000);

  // Fault detected (review, P0): with the computer's hello forwarded, generation 0 left
  // the real core unframed, and a raw line inside a channel frame started a terminal.
  it("never lets a downgraded hello or a smuggled line reach the real core", async () => {
    const socket = connect(join(core, "r", "herdr-core", "mx.sock"));
    const g = guard();
    const replies: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => replies.push(chunk));
    g.connect((bytes) => socket.write(bytes));
    const smuggled = Buffer.concat([
      Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true, generation: 0 } })}\n`),
      encodeFrame(5, HC_FRAME.DATA, Buffer.from(`\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "terminal.run", params: { argv: ["sh", "-c", "sleep 30"], name: "smuggled" } })}\n`)),
    ]);
    await expect(g.push(smuggled)).rejects.toBeInstanceOf(DesktopLinkGuardError);
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.destroy();
    // The core got only the guard's own hello: nothing was started.
    expect(Buffer.concat(replies).toString()).not.toContain("smuggled");
    expect(execFileSync(binary!, ["ls", "--all"], { env, timeout: 5_000, encoding: "utf8" })).not.toContain("smuggled");
  }, 20_000);
});
