// Herdr sessions on a Matrix computer (spec 651 J6): the same herdr-core the
// Herdr app uses there, reached over a byte stream the host does not own.
// Outcome protected: a terminal either app starts is listed, opened and ended
// by the other, and the app never does more on that computer than that.
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectHc, type HcSocket } from "@desktop/main/local-terminals/hc-client";
import { encodeFrame, HC_FRAME } from "@desktop/main/local-terminals/hc-protocol";
import { createAttachmentSlots } from "@desktop/main/local-terminals/hc-sessions";
import {
  acceptsRemoteCore, createHerdrSessionHost, HERDR_SESSION_METHODS, HerdrTransportError, restrictHcConnection,
} from "@desktop/main/local-terminals/herdr-session-host";
import { fakeCore } from "./fixtures/fake-herdr-core";

const REMOTE_HELLO = { version: "0.1.14", generation: 1, framed: true, features: ["framed", "attach", "events", "status", "shell"],
  methods: ["hello", "terminal.run", "terminal.list", "terminal.kill", "terminal.attach", "server.stop", "machine.add", "file.write"], core: {} };
type Call = { id: number; method: string; params: Record<string, unknown> };
type Core = ReturnType<typeof fakeCore>;

describe("which remote cores are accepted", () => {
  const hello = (overrides: Partial<typeof REMOTE_HELLO>) => ({ ...REMOTE_HELLO, ...overrides });
  it("accepts 0.1.14 and later in the 0.1 line when every feature and method it uses is present", () => {
    for (const version of ["0.1.14", "0.1.19", "0.1.20", "0.1.999"]) expect(acceptsRemoteCore(hello({ version })), version).toBe(true);
  });
  it("refuses older, newer-line and unreadable versions", () => {
    for (const version of ["0.1.13", "0.1.9", "0.2.0", "1.0.0", "0.1.20-beta", "0.1", "", "0.1.14\n"]) {
      expect(acceptsRemoteCore(hello({ version })), JSON.stringify(version)).toBe(false);
    }
  });
  it("refuses a core missing a feature or method this feature needs", () => {
    expect(acceptsRemoteCore(hello({ features: ["framed", "attach"] }))).toBe(false);
    expect(acceptsRemoteCore(hello({ methods: ["hello", "terminal.list", "terminal.attach", "terminal.kill"] }))).toBe(false);
  });
});

describe("what may be sent to a remote core", () => {
  it("passes only the listed methods and refuses everything else before it is written", async () => {
    const core = fakeCore({ hello: { result: REMOTE_HELLO } });
    core.onCall((call) => core.reply(call.id, { result: { terminals: [] } }));
    const connection = restrictHcConnection(await connectHc({ open: () => core.socket, accepts: () => true }), new Set(HERDR_SESSION_METHODS));
    await connection.call("terminal.list", {});
    for (const method of ["server.stop", "server.restart", "machine.add", "machine.exec", "file.write", "doc.set", "terminal.send", "terminal.keys", "terminal.put", "terminal.rm", "rpc.discover"]) {
      await expect(connection.call(method, {}), method).rejects.toThrow("not allowed");
    }
    expect(core.sent.calls.map((call) => call.method)).toEqual(["terminal.list"]);
    expect([...HERDR_SESSION_METHODS].sort()).toEqual(["terminal.attach", "terminal.kill", "terminal.list", "terminal.run"]);
  });
});

describe("herdr session host against a scripted core", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.useRealTimers(); });

  function start(script: (core: Core, call: Call) => void, overrides: Partial<Parameters<typeof createHerdrSessionHost>[0]> = {}, hello: Record<string, unknown> = { result: REMOTE_HELLO }) {
    const cores: Core[] = [];
    const sink = { output: vi.fn(), closed: vi.fn() };
    const open = vi.fn(async (): Promise<HcSocket> => {
      const core = fakeCore({ hello });
      core.onCall((call) => script(core, call));
      cores.push(core);
      return core.socket;
    });
    const host = createHerdrSessionHost({ open, ...overrides }, sink);
    return { host, sink, open, cores };
  }
  const script = (terminals: unknown[] = []) => (core: Core, call: Call) => {
    if (call.method === "terminal.list") core.reply(call.id, { result: { terminals } });
    if (call.method === "terminal.run") core.reply(call.id, { result: { address: "t7" } });
    if (call.method === "terminal.kill") core.reply(call.id, { result: {} });
    if (call.method === "terminal.attach") core.reply(call.id, { result: { channel: 5 } });
  };
  /** A stream that ends the way the transport reports it. */
  function failing(error: Error) {
    const socket = new EventEmitter() as EventEmitter & HcSocket;
    socket.write = () => { queueMicrotask(() => { socket.emit("error", error); socket.emit("close"); }); };
    socket.destroy = () => undefined;
    return socket;
  }

  it("lists the computer's own terminals with safe titles and never another machine's", async () => {
    const { host } = start(script([
      { address: "t3", state: "live", title: "‮claude\u0007", status: { state: "working", message: "free text" } },
      { address: "laptop/t1", state: "live", title: "reached through that core" },
      { address: "t4", state: "finished" },
    ]));
    expect(await host.list()).toEqual([{ id: "t3", title: "claude", status: "working" }]);
    expect(host.status()).toBe("ready");
  });

  it("starts that computer's own shell and sends no program, directory or environment of its own", async () => {
    const { host, cores } = start(script());
    expect(await host.create({ cols: 100, rows: 30 })).toBe("t7");
    expect(cores[0]!.sent.calls).toEqual([expect.objectContaining({ method: "terminal.run", params: {
      size: { cols: 100, rows: 30 }, env: { TERM: "xterm-256color", COLORTERM: "truecolor" }, no_parent: true, no_notify: true, wait: false,
    } })]);
  });

  it("rate-limits creation instead of capping how many terminals exist", async () => {
    let time = 1_000;
    const { host } = start(script(), { now: () => time });
    for (let index = 0; index < 10; index += 1) expect(await host.create({ cols: 80, rows: 24 })).toBe("t7");
    expect(await host.create({ cols: 80, rows: 24 })).toBeNull();
    time += 10_001;
    expect(await host.create({ cols: 80, rows: 24 })).toBe("t7");
  });

  it("only ever sends the four terminal methods across a whole session", async () => {
    const { host, cores } = start(script());
    await host.list();
    await host.create({ cols: 80, rows: 24 });
    const attachId = await host.attach("t7", { cols: 80, rows: 24 });
    host.detach(attachId);
    await host.kill("t7");
    host.dispose();
    const sent = new Set(cores[0]!.sent.calls.map((call) => call.method));
    for (const method of sent) expect(HERDR_SESSION_METHODS).toContain(method);
    expect(sent.size).toBe(4);
  });

  it("carries output through the shared flow control and ends attachments when the line drops", async () => {
    const { host, sink, cores, open } = start(script());
    const attachId = await host.attach("t7", { cols: 80, rows: 24 });
    const core = cores[0]!;
    core.stream(5, HC_FRAME.DATA, Buffer.from("hello"));
    expect(sink.output).toHaveBeenCalledWith(attachId, "hello");
    // Nothing is credited until the window says it took the output.
    expect(core.sent.frames.filter((frame) => frame.kind === HC_FRAME.CREDIT)).toHaveLength(0);
    expect(host.acknowledge(attachId, 1)).toBe(true);
    expect(core.sent.frames.filter((frame) => frame.kind === HC_FRAME.CREDIT)).toHaveLength(1);
    expect(host.input(attachId, "ls\r", false)).toBe(true);
    expect(core.sent.frames.some((frame) => frame.channel === 5 && frame.kind === HC_FRAME.DATA && frame.payload.toString() === "ls\r")).toBe(true);

    core.socket.emit("close");
    expect(sink.closed).toHaveBeenCalledWith(attachId);
    expect(host.input(attachId, "x", false)).toBe(false);
    // The terminal is still running there: the next use reconnects, and nothing was ended.
    expect(await host.list()).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(cores.flatMap((each) => each.sent.calls).some((call) => call.method === "terminal.kill")).toBe(false);
  });

  it("refuses an unsupported core, sends it nothing more, and does not redial until asked", async () => {
    const { host, open, cores } = start(script(), {}, { result: { ...REMOTE_HELLO, version: "0.1.9" } });
    await expect(host.list()).rejects.toThrow();
    expect(host.status()).toBe("unsupported");
    expect(cores[0]!.sent.calls).toEqual([]);
    await expect(host.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    host.retry();
    await expect(host.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not-installed", "not-installed"], ["identity-changed", "identity-changed"], ["not-enabled", "not-enabled"],
  ] as const)("reports a transport that ends as %s with that fixed status, without redialing", async (kind, status) => {
    const open = vi.fn(async () => failing(new HerdrTransportError(kind)));
    const { host } = start(script(), { open });
    await expect(host.list()).rejects.toThrow();
    expect(host.status()).toBe(status);
    await expect(host.create({ cols: 80, rows: 24 })).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("treats text before the handshake as unavailable, never as a crash", async () => {
    const noisy = new EventEmitter() as EventEmitter & HcSocket;
    noisy.write = () => { queueMicrotask(() => noisy.emit("data", Buffer.from("motd: welcome\n"))); };
    noisy.destroy = () => undefined;
    const { host } = start(script(), { open: async () => noisy });
    await expect(host.list()).rejects.toThrow();
    expect(host.status()).toBe("unavailable");
  });

  it("backs off after a failed connection instead of dialing on every poll", async () => {
    let time = 0;
    let fail = true;
    const working = start(script());
    const open = vi.fn(async () => { if (fail) throw new Error("connect failed"); return working.open(); });
    const { host } = start(script(), { open, now: () => time, random: () => 1 });
    await expect(host.list()).rejects.toThrow();
    expect(host.status()).toBe("unavailable");
    for (let poll = 0; poll < 5; poll += 1) await expect(host.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    time += 1_001;
    await expect(host.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(2);
    // The wait doubles, up to half a minute.
    time += 1_001;
    await expect(host.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(2);
    time += 1_000;
    fail = false;
    expect(await host.list()).toEqual([]);
    expect(host.status()).toBe("ready");
  });

  it("closes an idle connection and keeps one that has a terminal open", async () => {
    vi.useFakeTimers();
    const idle = start(script(), { idleMs: 60_000 });
    await idle.host.list();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(idle.cores[0]!.socket.destroyed).toBe(true);
    expect(idle.sink.closed).not.toHaveBeenCalled();
    await idle.host.list();
    expect(idle.open).toHaveBeenCalledTimes(2);

    const busy = start(script(), { idleMs: 60_000 });
    await busy.host.attach("t7", { cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(busy.cores[0]!.socket.destroyed).toBe(false);
  });

  it("shares one attachment budget and one id space between computers", async () => {
    const slots = createAttachmentSlots(3);
    const one = start(script(), { slots });
    const two = start(script(), { slots });
    const ids = [await one.host.attach("t7", { cols: 80, rows: 24 }), await two.host.attach("t7", { cols: 80, rows: 24 })];
    two.cores[0]!.onCall((call) => { if (call.method === "terminal.attach") two.cores[0]!.reply(call.id, { result: { channel: 6 } }); });
    ids.push(await two.host.attach("t7", { cols: 80, rows: 24 }));
    expect(new Set(ids).size).toBe(3);
    await expect(one.host.attach("t7", { cols: 80, rows: 24 })).rejects.toThrow("too many");
    two.host.detach(ids[1]!);
    one.cores[0]!.onCall((call) => { if (call.method === "terminal.attach") one.cores[0]!.reply(call.id, { result: { channel: 8 } }); });
    const next = await one.host.attach("t7", { cols: 80, rows: 24 });
    expect(ids).not.toContain(next);
  });

  it("gives its attachments back when it is disposed, and ends nothing on the computer", async () => {
    const slots = createAttachmentSlots(1);
    const { host, cores } = start(script(), { slots });
    await host.attach("t7", { cols: 80, rows: 24 });
    host.dispose();
    expect(cores[0]!.socket.destroyed).toBe(true);
    expect(slots.acquire()).not.toBeNull();
    expect(cores[0]!.sent.calls.some((call) => call.method === "terminal.kill")).toBe(false);
    await expect(host.list()).rejects.toThrow();
  });

  it("destroys a stream that opens after the host was disposed", async () => {
    let release!: (socket: HcSocket) => void;
    const late = fakeCore({ hello: { result: REMOTE_HELLO } });
    const { host } = start(script(), { open: () => new Promise<HcSocket>((resolve) => { release = resolve; }) });
    const pending = host.list();
    host.dispose();
    release(late.socket);
    await expect(pending).rejects.toThrow();
    expect(late.socket.destroyed).toBe(true);
  });
});

// The real herdr-core, reached the way the SSH transport will reach it: the
// stdin and stdout of `herdr-core connect`. A second, plain `hc` client stands
// in for the Herdr app. Runs where a supported binary is installed (or
// MATRIX_DESKTOP_HC_PATH names one); set MATRIX_DESKTOP_HC_REQUIRED=1 to fail
// instead of skip. The scripted suite above always runs.
const candidates = [process.env.MATRIX_DESKTOP_HC_PATH, join(homedir(), ".local/bin/hc")].filter((path): path is string => !!path);
const binary = candidates.find((path) => {
  try {
    const version = existsSync(path) ? execFileSync(path, ["--version"], { encoding: "utf8", timeout: 3_000 }).trim().split(" ").pop() ?? "" : "";
    return acceptsRemoteCore({ ...REMOTE_HELLO, version });
  } catch (error: unknown) {
    console.warn("herdr-core probe failed:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
});
if (process.env.MATRIX_DESKTOP_HC_REQUIRED === "1" && !binary) throw new Error("a supported herdr-core is required for this lane");

(binary ? describe : describe.skip)("herdr sessions on the real herdr-core, shared with a second client", () => {
  // A short path: Unix sockets cannot live under a long temporary directory.
  const root = binary ? mkdtempSync("/tmp/mxr-") : "";
  // The "computer": its own state, sockets and session, apart from any herdr the developer runs.
  const env = { HOME: root, PATH: "/usr/bin:/bin", XDG_STATE_HOME: join(root, "s"), XDG_CONFIG_HOME: join(root, "c"), XDG_RUNTIME_DIR: join(root, "r"), HC_SESSION: "mxr" };
  const other = (...args: string[]) => execFileSync(binary!, ["--json", ...args], { env, encoding: "utf8", timeout: 20_000 });
  const outputs = new Map<number, string>();
  const closed: number[] = [];
  const sink = {
    output: (id: number, data: string) => { outputs.set(id, (outputs.get(id) ?? "") + data); host.acknowledge(id, 1); },
    closed: (id: number) => { closed.push(id); },
  };
  const open = async (): Promise<HcSocket> => {
    const child = spawn(binary!, ["connect"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const socket = new EventEmitter() as EventEmitter & HcSocket;
    child.stdout.on("data", (chunk: Buffer) => socket.emit("data", chunk));
    child.on("error", (error) => socket.emit("error", error));
    child.on("close", () => socket.emit("close"));
    socket.write = (data) => child.stdin.write(data);
    socket.destroy = () => { child.stdin.end(); child.kill(); };
    return socket;
  };
  const until = (read: () => boolean) => vi.waitFor(() => { if (!read()) throw new Error("waiting"); }, { timeout: 15_000, interval: 50 });
  const host = createHerdrSessionHost({ open }, sink);
  let mine = "";

  beforeAll(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterAll(() => {
    host.dispose();
    try { other("server", "stop"); }
    catch (error: unknown) { console.error("test core stop failed", error instanceof Error ? error.name : error); }
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a terminal the second client can see, read and type into", async () => {
    const created = await host.create({ cols: 100, rows: 30 });
    expect(created).toMatch(/^t[0-9]+$/);
    mine = created!;
    expect(JSON.parse(other("ls")).terminals.map((terminal: { address: string }) => terminal.address)).toEqual([mine]);

    const attachId = await host.attach(mine, { cols: 100, rows: 30 });
    host.input(attachId, "echo APP_$((40+2))\r", false);
    await until(() => (outputs.get(attachId) ?? "").includes("APP_42"));
    expect(other("read", mine)).toContain("APP_42");
    other("send", mine, "echo OTHER_$((1+1))");
    await until(() => (outputs.get(attachId) ?? "").includes("OTHER_2"));
    host.detach(attachId);
  }, 120_000);

  it("lists and ends a terminal the second client started, and sees its own ended by that client", async () => {
    const theirs = JSON.parse(other("run", "--bg", "sleep 300")).address as string;
    expect((await host.list()).map((terminal) => terminal.id).sort()).toEqual([mine, theirs].sort());
    await host.kill(theirs);
    expect(JSON.parse(other("ls")).terminals.map((terminal: { address: string }) => terminal.address)).toEqual([mine]);

    const attachId = await host.attach(mine, { cols: 100, rows: 30 });
    other("kill", mine);
    await until(() => closed.includes(attachId));
    expect(await host.list()).toEqual([]);
  }, 60_000);
});
