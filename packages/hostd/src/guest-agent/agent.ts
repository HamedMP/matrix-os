import { execFile } from "node:child_process";
import { chmod, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { MAX_LINE_BYTES, type GuestStats } from "./protocol.js";

// Matrix guest agent: runs inside each VM and answers the host's memory
// controller and suspend path. Newline-delimited JSON, one response per line:
//   {"op":"stats"} -> { psiSome10, availableMiB, anonMiB }
//   {"op":"trim"}  -> { ok: true } after sync, drop_caches, compact_memory
//   anything else  -> { error: "bad_request" }
// The transport is thin on purpose: `--listen <path>` serves a unix socket
// that socat bridges from AF_VSOCK port 1024 (Node has no AF_VSOCK server),
// and `--stdio` serves one connection on stdin/stdout. This file imports only
// node: built-ins (and ./protocol.ts) so it builds to a single file for the golden disk.

export { GUEST_AGENT_PORT, MAX_LINE_BYTES, type GuestStats } from "./protocol.js";
export const IDLE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 8;
const TRIM_TIMEOUT_MS = 60_000;
const KIB_PER_MIB = 1024;

export type GuestResponse = GuestStats | { ok: true } | { error: "bad_request" | "unavailable" };

export interface GuestAgentDeps {
  readProc(path: string): Promise<string>;
  trim(): Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface GuestAgent {
  handleLine(line: string): Promise<GuestResponse>;
}

const defaultLog = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }));

const errorFields = (error: unknown) =>
  error instanceof Error ? { error: error.name, code: (error as { code?: unknown }).code } : { error: String(error) };

function meminfoKiB(meminfo: string, key: string): number {
  const match = new RegExp(`^${key.replace(/[()]/g, "\\$&")}:\\s+(\\d+) kB$`, "m").exec(meminfo);
  if (match === null) throw new RangeError(`meminfo has no ${key}`);
  return Number(match[1]);
}

export function parseMemoryStats(pressure: string, meminfo: string): GuestStats {
  const some = /^some avg10=(\d+(?:\.\d+)?) /m.exec(pressure);
  if (some === null) throw new RangeError("memory pressure has no some avg10");
  const anonKiB = meminfoKiB(meminfo, "Active(anon)") + meminfoKiB(meminfo, "Inactive(anon)");
  return {
    psiSome10: Number(some[1]),
    availableMiB: Math.floor(meminfoKiB(meminfo, "MemAvailable") / KIB_PER_MIB),
    anonMiB: Math.floor(anonKiB / KIB_PER_MIB),
  };
}

function parseOp(line: string): "stats" | "trim" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "op") return null;
  const op = (parsed as { op: unknown }).op;
  return op === "stats" || op === "trim" ? op : null;
}

export function createGuestAgent(deps: GuestAgentDeps): GuestAgent {
  const log = deps.log ?? defaultLog;
  // Concurrent trims (several connections) share one run.
  let trimming: Promise<void> | null = null;

  return {
    async handleLine(line) {
      const op = parseOp(line);
      if (op === null) return { error: "bad_request" };
      try {
        if (op === "stats") {
          const [pressure, meminfo] = await Promise.all([
            deps.readProc("/proc/pressure/memory"),
            deps.readProc("/proc/meminfo"),
          ]);
          return parseMemoryStats(pressure, meminfo);
        }
        trimming ??= deps.trim().finally(() => {
          trimming = null;
        });
        await trimming;
        return { ok: true };
      } catch (error: unknown) {
        log("guest_agent_op_failed", { op, ...errorFields(error) });
        return { error: "unavailable" };
      }
    },
  };
}

// Serves one connection: requests are answered in order, a line over
// MAX_LINE_BYTES is answered bad_request and closes the connection, and the
// connection closes after `idleMs` without input. Resolves once output ended.
export function serveConnection(
  agent: GuestAgent,
  input: Readable,
  output: Writable,
  options: { idleMs?: number } = {},
): Promise<void> {
  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
  return new Promise<void>((resolve) => {
    let pending = Buffer.alloc(0);
    let work: Promise<void> = Promise.resolve();
    let closing = false;
    let timer: NodeJS.Timeout | undefined;

    // Waits for the peer to read once the output buffer is full, so a peer
    // that never reads stalls the agent instead of growing its buffer. A peer
    // that reads nothing for `idleMs` is dropped.
    const send = async (response: GuestResponse) => {
      if (output.writableEnded || output.destroyed) return;
      if (output.write(`${JSON.stringify(response)}\n`)) return;
      await new Promise<void>((resolve) => {
        const stalled = setTimeout(() => output.destroy(), idleMs);
        const done = () => {
          clearTimeout(stalled);
          output.off("drain", done);
          output.off("close", done);
          output.off("error", done);
          resolve();
        };
        output.on("drain", done);
        output.on("close", done);
        output.on("error", done);
      });
    };

    const close = () => {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", close);
      input.off("error", onInputError);
      void work.then(() => {
        if (output.writableEnded || output.destroyed) {
          resolve();
          return;
        }
        output.end(() => resolve());
      });
    };

    const armIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(close, idleMs);
    };

    function onInputError(error: unknown) {
      defaultLog("guest_agent_input_failed", errorFields(error));
      close();
    }

    function onData(chunk: Buffer | string) {
      armIdle();
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const lines: string[] = [];
      let oversize = false;
      let index = pending.indexOf(0x0a);
      while (index >= 0) {
        if (index > MAX_LINE_BYTES) {
          oversize = true;
          break;
        }
        lines.push(pending.subarray(0, index).toString("utf8").replace(/\r$/, ""));
        pending = pending.subarray(index + 1);
        index = pending.indexOf(0x0a);
      }
      if (!oversize && pending.length > MAX_LINE_BYTES) oversize = true;
      if (lines.length > 0) {
        // Backpressure: read no further input while these lines are answered.
        input.pause();
        work = work.then(async () => {
          for (const line of lines) await send(await agent.handleLine(line));
          if (!closing) input.resume();
        });
      }
      if (oversize) {
        work = work.then(() => send({ error: "bad_request" }));
        close();
      }
    }

    output.on("error", (error: unknown) => {
      defaultLog("guest_agent_output_failed", errorFields(error));
      close();
      resolve();
    });
    input.on("data", onData);
    input.on("end", close);
    input.on("error", onInputError);
    armIdle();
  });
}

function runSync(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sync", [], { timeout: TRIM_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
  });
}

export const TRIM_PATHS = { dropCaches: "/proc/sys/vm/drop_caches", compactMemory: "/proc/sys/vm/compact_memory" };

// From the S7 spike: sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory
export async function trimGuestMemory(paths: typeof TRIM_PATHS = TRIM_PATHS): Promise<void> {
  await runSync();
  await writeFile(paths.dropCaches, "3");
  await writeFile(paths.compactMemory, "1");
}

export function createSystemGuestAgent(): GuestAgent {
  return createGuestAgent({ readProc: (path) => readFile(path, "utf8"), trim: () => trimGuestMemory() });
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error("listen path exists and is not a socket");
    await unlink(path);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
}

export interface SignalSource {
  once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

// Serves the agent on a unix socket (0600) that socat bridges from vsock.
// Half-open connections are allowed so a client that sends its request and
// then shuts down its write side still gets the answer.
export async function listenGuestAgent(
  path: string,
  agent: GuestAgent = createSystemGuestAgent(),
  signals: SignalSource = process,
): Promise<Server> {
  await removeStaleSocket(path);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", (error: unknown) => defaultLog("guest_agent_socket_failed", errorFields(error)));
    void serveConnection(agent, socket, socket).then(() => socket.destroy());
  });
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  const shutdown = () => server.close();
  signals.once("SIGTERM", shutdown);
  signals.once("SIGINT", shutdown);
  return server;
}

export interface AgentProcess extends SignalSource {
  stdin: Readable;
  stdout: Writable;
  exitCode?: number | string | null;
}

// `makeAgent` lets tests serve a controlled agent: the system agent's trim
// drops the caches and compacts the memory of whatever machine runs it.
export async function main(
  argv: readonly string[],
  proc: AgentProcess = process,
  makeAgent: () => GuestAgent = createSystemGuestAgent,
): Promise<void> {
  if (argv[0] === "--stdio") {
    await serveConnection(makeAgent(), proc.stdin, proc.stdout);
    return;
  }
  if (argv[0] === "--listen" && typeof argv[1] === "string" && argv[1].startsWith("/")) {
    await listenGuestAgent(argv[1], makeAgent(), proc);
    return;
  }
  defaultLog("guest_agent_usage", { usage: "agent.js --listen <absolute socket path> | --stdio" });
  proc.exitCode = 2;
}

// Runs main and turns a startup failure into exit code 1.
export function runMain(argv: readonly string[], proc: AgentProcess = process): Promise<void> {
  return main(argv, proc).catch((error: unknown) => {
    defaultLog("guest_agent_failed", errorFields(error));
    proc.exitCode = 1;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void runMain(process.argv.slice(2));
