import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGuestAgent,
  listenGuestAgent,
  main,
  MAX_LINE_BYTES,
  runMain,
  serveConnection,
  trimGuestMemory,
  type AgentProcess,
  type GuestAgent,
} from "../../packages/hostd/src/guest-agent/agent.js";

const PRESSURE = "some avg10=1.00 avg60=0.00 avg300=0.00 total=1\n";
const MEMINFO = "MemAvailable:     409600 kB\nActive(anon):    1024 kB\nInactive(anon):   1024 kB\n";
const fixture = (trim: () => Promise<void> = async () => undefined): GuestAgent =>
  createGuestAgent({ readProc: async (p) => (p === "/proc/meminfo" ? MEMINFO : PRESSURE), trim, log: () => undefined });

let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-agent-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) if (server.listening) await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

function signals() {
  const emitter = new EventEmitter();
  return { once: (s: "SIGTERM" | "SIGINT", fn: () => void) => emitter.once(s, fn), emit: (s: string) => emitter.emit(s) };
}

// Sends `payload`, half-closes, and collects the reply until the agent closes.
function ask(path: string, payload: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(text.split("\n").filter(Boolean)));
    socket.on("connect", () => socket.end(payload));
  });
}

function converse(agent: GuestAgent, options: { encoding?: boolean } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (options.encoding) input.setEncoding("utf8");
  const lines: string[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    lines.push(...parts);
  });
  return { input, output, lines, ended: serveConnection(agent, input, output) };
}

describe("guest agent transport", () => {
  it("listens on a 0600 unix socket and answers a client that half-closes after its request", async () => {
    const path = join(dir, "agent.sock");
    const server = await listenGuestAgent(path, fixture(), signals());
    servers.push(server);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(server.maxConnections).toBe(8);
    expect(await ask(path, '{"op":"stats"}\n')).toEqual(['{"psiSome10":1,"availableMiB":400,"anonMiB":2}']);
  });

  it("replaces a stale socket left by a previous run", async () => {
    const path = join(dir, "agent.sock");
    const stale = createServer();
    await new Promise<void>((r) => stale.listen(path, r));
    servers.push(stale);
    const server = await listenGuestAgent(path, fixture(), signals());
    servers.push(server);
    expect(await ask(path, '{"op":"trim"}\n')).toEqual(['{"ok":true}']);
  });

  it("refuses to replace a path that is not a socket", async () => {
    const path = join(dir, "agent.sock");
    await writeFile(path, "keep me");
    await expect(listenGuestAgent(path, fixture(), signals())).rejects.toThrow("not a socket");
    await expect(readFile(path, "utf8")).resolves.toBe("keep me");
  });

  it("stops listening on SIGTERM and on SIGINT", async () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const sig = signals();
      const server = await listenGuestAgent(join(dir, `${signal}.sock`), fixture(), sig);
      servers.push(server);
      sig.emit(signal);
      await new Promise((r) => setImmediate(r));
      expect(server.listening).toBe(false);
    }
  });

  it("main --listen serves the system agent with real /proc stats", async () => {
    const path = join(dir, "main.sock");
    const sig = signals();
    const proc = { ...sig, stdin: new PassThrough(), stdout: new PassThrough() } as AgentProcess;
    await main(["--listen", path], proc);
    const [line] = await ask(path, '{"op":"stats"}\n');
    expect(JSON.parse(line!)).toMatchObject({ availableMiB: expect.any(Number), anonMiB: expect.any(Number) });
    sig.emit("SIGTERM");
  });

  it("main --stdio serves one connection, and a failing system trim answers unavailable", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString()));
    const proc = { ...signals(), stdin, stdout } as AgentProcess;
    const done = main(["--stdio"], proc);
    // Unprivileged: /proc/sys/vm/drop_caches is not writable, so the trim fails closed.
    stdin.end('{"op":"trim"}\n');
    await done;
    const expected = process.getuid?.() === 0 ? { ok: true } : { error: "unavailable" };
    expect(JSON.parse(out.trim())).toEqual(expected);
  });

  it("main prints usage with exit code 2 for bad arguments, and runMain exits 1 on a startup failure", async () => {
    const proc = { ...signals(), stdin: new PassThrough(), stdout: new PassThrough() } as AgentProcess;
    await main(["--listen", "relative.sock"], proc);
    expect(proc.exitCode).toBe(2);
    const failing = { ...signals(), stdin: new PassThrough(), stdout: new PassThrough() } as AgentProcess;
    await runMain(["--listen", join(dir, "missing-dir", "agent.sock")], failing);
    expect(failing.exitCode).toBe(1);
  });

  it("trimGuestMemory syncs, then writes drop_caches=3 and compact_memory=1", async () => {
    const paths = { dropCaches: join(dir, "drop_caches"), compactMemory: join(dir, "compact_memory") };
    await trimGuestMemory(paths);
    await expect(readFile(paths.dropCaches, "utf8")).resolves.toBe("3");
    await expect(readFile(paths.compactMemory, "utf8")).resolves.toBe("1");
  });
});

describe("guest agent line framing", () => {
  it("accepts a line of exactly 4096 bytes ending in a newline and keeps the connection", async () => {
    const convo = converse(fixture());
    convo.input.write(`${"x".repeat(MAX_LINE_BYTES)}\n{"op":"trim"}\n`);
    convo.input.end();
    await convo.ended;
    expect(convo.lines).toEqual(['{"error":"bad_request"}', '{"ok":true}']);
  });

  it("rejects a 4097-byte line that ends in a newline and answers the lines before it", async () => {
    const convo = converse(fixture());
    convo.input.write(`{"op":"trim"}\n${"x".repeat(MAX_LINE_BYTES + 1)}\n{"op":"trim"}\n`);
    await convo.ended;
    expect(convo.lines).toEqual(['{"ok":true}', '{"error":"bad_request"}']);
  });

  it("accepts string chunks", async () => {
    const convo = converse(fixture(), { encoding: true });
    convo.input.end('{"op":"trim"}\n');
    await convo.ended;
    expect(convo.lines).toEqual(['{"ok":true}']);
  });

  it("shares one trim across concurrent requests and reports a non-Error failure as unavailable", async () => {
    let runs = 0;
    const agent = fixture(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    await Promise.all([agent.handleLine('{"op":"trim"}'), agent.handleLine('{"op":"trim"}')]);
    expect(runs).toBe(1);
    const broken = fixture(() => Promise.reject("plain string"));
    await expect(broken.handleLine('{"op":"trim"}')).resolves.toEqual({ error: "unavailable" });
  });

  it("closes on an input error and resolves on an output error", async () => {
    const a = converse(fixture());
    a.input.destroy(new Error("reset"));
    await a.ended;
    const b = converse(fixture());
    b.output.destroy(new Error("broken pipe"));
    await b.ended;
    expect(b.output.destroyed).toBe(true);
  });

  it("logs a socket error on an accepted connection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await listenGuestAgent(join(dir, "err.sock"), fixture(), signals());
    servers.push(server);
    const fake = new PassThrough();
    server.emit("connection", fake);
    fake.emit("error", new Error("reset"));
    expect(error.mock.calls.some((c) => String(c[0]).includes("guest_agent_socket_failed"))).toBe(true);
    fake.end();
  });

  it("closes once when the output fails after the input ended", async () => {
    const c = converse(fixture());
    c.input.end();
    c.output.destroy(new Error("late"));
    await c.ended;
  });

  it("rethrows a JSON parse failure that is not a syntax error", async () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new RangeError("stack");
    });
    await expect(fixture().handleLine('{"op":"trim"}')).rejects.toBeInstanceOf(RangeError);
  });

  it("does not write after the output has ended", async () => {
    const c = converse(fixture());
    c.output.end();
    c.input.end('{"op":"trim"}\n');
    await c.ended;
    expect(c.lines).toEqual([]);
  });
});
