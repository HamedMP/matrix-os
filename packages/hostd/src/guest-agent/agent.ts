import { execFile } from "node:child_process";
import { chmod, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

// Matrix guest agent: runs inside each VM and answers the host's memory
// controller and suspend path. Newline-delimited JSON, one response per line:
//   {"op":"stats"} -> { psiSome10, availableMiB, anonMiB }
//   {"op":"trim"}  -> { ok: true } after sync, drop_caches, compact_memory
//   anything else  -> { error: "bad_request" }
// The transport is thin on purpose: `--listen <path>` serves a unix socket
// that socat bridges from AF_VSOCK port 1024 (Node has no AF_VSOCK server),
// and `--stdio` serves one connection on stdin/stdout. This file imports only
// node: built-ins so it builds to a single file for the golden disk.

export const GUEST_AGENT_PORT = 1024;
export const MAX_LINE_BYTES = 4096;
export const IDLE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 8;
const TRIM_TIMEOUT_MS = 60_000;
const KIB_PER_MIB = 1024;

export interface GuestStats {
  psiSome10: number;
  availableMiB: number;
  anonMiB: number;
}

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

    const send = (response: GuestResponse) => {
      if (!output.writableEnded && !output.destroyed) output.write(`${JSON.stringify(response)}\n`);
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
          for (const line of lines) send(await agent.handleLine(line));
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
    execFile("sync", [], { timeout: TRIM_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
  });
}

// From the S7 spike: sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory
export async function trimGuestMemory(): Promise<void> {
  await runSync();
  await writeFile("/proc/sys/vm/drop_caches", "3");
  await writeFile("/proc/sys/vm/compact_memory", "1");
}

export function createSystemGuestAgent(): GuestAgent {
  return createGuestAgent({ readProc: (path) => readFile(path, "utf8"), trim: trimGuestMemory });
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

async function listen(path: string): Promise<void> {
  const agent = createSystemGuestAgent();
  await removeStaleSocket(path);
  const server = createServer((socket) => {
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
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "--stdio") {
    await serveConnection(createSystemGuestAgent(), process.stdin, process.stdout);
    return;
  }
  if (argv[0] === "--listen" && typeof argv[1] === "string" && argv[1].startsWith("/")) {
    await listen(argv[1]);
    return;
  }
  console.error("usage: agent.js --listen <absolute socket path> | --stdio");
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    defaultLog("guest_agent_failed", errorFields(error));
    process.exitCode = 1;
  });
}
