// Terminals for the desktop link on Windows (spec 2716), where herdr-core has
// no build. A small in-process core speaks the part of herdr-core's framed
// protocol that the computer's Herdr adapter uses (hello, terminal.list,
// terminal.run, terminal.attach, terminal.kill, and the stream frames), over
// ConPTY through node-pty. Every byte the computer sends still passes the
// desktop link guard first. Bounded: terminals, viewers, output history and
// queued output all have caps; every terminal ends when the app quits.
import { EventEmitter } from "node:events";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";

/** The parts of a node-pty IPty this uses. */
export interface WindowsPty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
}

export type SpawnWindowsPty = (file: string, args: string[], options: {
  name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConpty: boolean;
}) => WindowsPty;

export const WINDOWS_CORE_VERSION = "0.1.22";
const METHODS = ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"];
const MAX_LIVE_TERMINALS = 16;
const MAX_RECORDS = 64;
const MAX_VIEWERS_PER_TERMINAL = 8;
/** Output kept per terminal for a new viewer's replay. */
const HISTORY_BYTES = 512 * 1024;
/** Unacknowledged output per viewer before the program is paused. */
const CREDIT_WINDOW = 1024 * 1024;
/** Output queued for a viewer that has run out of credit; past this the viewer is dropped. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_HELLO_BYTES = 64 * 1024;
const POWERSHELL = "powershell.exe";

interface Viewer { channel: number; socket: CoreSocket; observe: boolean; unacked: number; queued: Buffer[]; queuedBytes: number }
interface Terminal {
  id: string; title: string; cwd: string; pty: WindowsPty | null; live: boolean; exitCode: number | null;
  history: Buffer[]; historyBytes: number; viewers: Map<number, Viewer>; paused: boolean;
  labels: Record<string, string>;
}

type CoreSocket = EventEmitter & HcSocket & { destroyed: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createWindowsCore(options: {
  spawn: SpawnWindowsPty;
  home: string;
  env: Record<string, string>;
  log?: (message: string) => void;
}) {
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  // Bounded by MAX_RECORDS: finished terminals are dropped oldest first.
  const terminals = new Map<string, Terminal>();
  const sockets = new Set<CoreSocket>();
  let nextId = 1;
  let nextChannel = 1;
  let disposed = false;

  function send(socket: CoreSocket, channel: number, kind: number, payload: Buffer): void {
    if (!socket.destroyed) socket.emit("data", encodeFrame(channel, kind, payload));
  }
  function reply(socket: CoreSocket, id: unknown, body: Record<string, unknown>): void {
    send(socket, 0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body })));
  }
  function fail(socket: CoreSocket, id: unknown, kind: string): void {
    reply(socket, id, { error: { code: -32000, message: kind, data: { kind } } });
  }

  function deliver(terminal: Terminal, viewer: Viewer, chunk: Buffer): void {
    if (viewer.unacked + chunk.length <= CREDIT_WINDOW && viewer.queued.length === 0) {
      viewer.unacked += chunk.length;
      send(viewer.socket, viewer.channel, HC_FRAME.DATA, chunk);
      return;
    }
    viewer.queued.push(chunk);
    viewer.queuedBytes += chunk.length;
    if (viewer.queuedBytes > MAX_QUEUED_BYTES) {
      // A viewer this far behind is gone in practice: drop it, not the terminal.
      detach(terminal, viewer, true);
      return;
    }
    if (!terminal.paused && terminal.pty) { terminal.pty.pause(); terminal.paused = true; }
  }

  function flush(terminal: Terminal, viewer: Viewer): void {
    while (viewer.queued.length > 0 && viewer.unacked + viewer.queued[0]!.length <= CREDIT_WINDOW) {
      const chunk = viewer.queued.shift()!;
      viewer.queuedBytes -= chunk.length;
      viewer.unacked += chunk.length;
      send(viewer.socket, viewer.channel, HC_FRAME.DATA, chunk);
    }
    const behind = [...terminal.viewers.values()].some((other) => other.queued.length > 0);
    if (!behind && terminal.paused && terminal.pty) { terminal.pty.resume(); terminal.paused = false; }
  }

  function detach(terminal: Terminal, viewer: Viewer, tell: boolean): void {
    if (!terminal.viewers.delete(viewer.channel)) return;
    if (tell) send(viewer.socket, viewer.channel, HC_FRAME.CLOSE, Buffer.alloc(0));
    if (terminal.paused && terminal.pty && ![...terminal.viewers.values()].some((other) => other.queued.length > 0)) {
      terminal.pty.resume();
      terminal.paused = false;
    }
  }

  function remember(terminal: Terminal, chunk: Buffer): void {
    terminal.history.push(chunk);
    terminal.historyBytes += chunk.length;
    while (terminal.historyBytes > HISTORY_BYTES && terminal.history.length > 1) {
      terminal.historyBytes -= terminal.history.shift()!.length;
    }
  }

  function prune(): void {
    while (terminals.size > MAX_RECORDS) {
      const oldest = [...terminals.values()].find((terminal) => !terminal.live);
      if (!oldest) return;
      terminals.delete(oldest.id);
    }
  }

  /** The program a run asks for: PowerShell by default, a PowerShell command line, or argv as given. */
  function program(params: Record<string, unknown>): { file: string; args: string[]; title: string } | null {
    const argv = params.argv;
    if (Array.isArray(argv) && argv.length > 0) {
      if (!argv.every((part): part is string => typeof part === "string")) return null;
      return { file: argv[0]!, args: argv.slice(1), title: argv[0]! };
    }
    if (typeof params.line === "string" && params.line.length > 0) {
      return { file: POWERSHELL, args: ["-NoLogo", "-Command", params.line], title: params.line.slice(0, 64) };
    }
    return { file: POWERSHELL, args: ["-NoLogo"], title: "PowerShell" };
  }

  function run(socket: CoreSocket, id: unknown, params: Record<string, unknown>): void {
    if ([...terminals.values()].filter((terminal) => terminal.live).length >= MAX_LIVE_TERMINALS) { fail(socket, id, "busy"); return; }
    const chosen = program(params);
    if (!chosen) { fail(socket, id, "invalid_params"); return; }
    const size = isRecord(params.size) ? params.size : {};
    const cols = typeof size.cols === "number" && size.cols >= 20 && size.cols <= 500 ? Math.trunc(size.cols) : 120;
    const rows = typeof size.rows === "number" && size.rows >= 5 && size.rows <= 200 ? Math.trunc(size.rows) : 36;
    // The guard already resolved and checked the folder; home when none was named.
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : options.home;
    const extra = isRecord(params.env) ? Object.fromEntries(Object.entries(params.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    let pty: WindowsPty;
    try {
      pty = options.spawn(chosen.file, chosen.args, { name: "xterm-256color", cols, rows, cwd, env: { ...options.env, ...extra }, useConpty: true });
    } catch (error: unknown) {
      log(`terminal start failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      fail(socket, id, "spawn_failed");
      return;
    }
    const address = `t${nextId++}`;
    const labels = isRecord(params.labels) ? Object.fromEntries(Object.entries(params.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    const terminal: Terminal = {
      id: address, title: typeof params.name === "string" && params.name ? params.name : chosen.title, cwd, pty, live: true, exitCode: null,
      history: [], historyBytes: 0, viewers: new Map(), paused: false, labels,
    };
    terminals.set(address, terminal);
    pty.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      remember(terminal, chunk);
      for (const viewer of [...terminal.viewers.values()]) deliver(terminal, viewer, chunk);
    });
    pty.onExit(({ exitCode }) => {
      terminal.live = false;
      terminal.exitCode = exitCode;
      terminal.pty = null;
      for (const viewer of [...terminal.viewers.values()]) detach(terminal, viewer, true);
      prune();
    });
    reply(socket, id, { result: { address, state: "live", cwd, labels } });
  }

  function attach(socket: CoreSocket, id: unknown, params: Record<string, unknown>): void {
    const terminal = typeof params.terminal === "string" ? terminals.get(params.terminal) : undefined;
    if (!terminal) { fail(socket, id, "not_found"); return; }
    if (!terminal.live) { fail(socket, id, "finished"); return; }
    if (terminal.viewers.size >= MAX_VIEWERS_PER_TERMINAL) { fail(socket, id, "busy"); return; }
    const channel = nextChannel++;
    const viewer: Viewer = { channel, socket, observe: params.observe === true, unacked: 0, queued: [], queuedBytes: 0 };
    terminal.viewers.set(channel, viewer);
    if (!viewer.observe && typeof params.cols === "number" && typeof params.rows === "number" && terminal.pty) {
      terminal.pty.resize(Math.max(20, Math.min(500, Math.trunc(params.cols))), Math.max(5, Math.min(200, Math.trunc(params.rows))));
    }
    reply(socket, id, { result: { channel } });
    // The replay, then live output, under the same credit rules.
    for (const chunk of terminal.history) deliver(terminal, viewer, chunk);
  }

  function kill(socket: CoreSocket, id: unknown, params: Record<string, unknown>): void {
    const terminal = typeof params.terminal === "string" ? terminals.get(params.terminal) : undefined;
    if (!terminal) { fail(socket, id, "not_found"); return; }
    terminals.delete(terminal.id);
    for (const viewer of [...terminal.viewers.values()]) detach(terminal, viewer, true);
    try { terminal.pty?.kill(); } catch (error: unknown) {
      log(`terminal end failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    }
    reply(socket, id, { result: {} });
  }

  function list(socket: CoreSocket, id: unknown): void {
    reply(socket, id, { result: { terminals: [...terminals.values()].map((terminal) => ({
      address: terminal.id, state: terminal.live ? "live" : "finished", title: terminal.title, name: terminal.title,
      status: null, labels: terminal.labels, exit_code: terminal.exitCode,
    })) } });
  }

  function viewerOf(socket: CoreSocket, channel: number): { terminal: Terminal; viewer: Viewer } | null {
    for (const terminal of terminals.values()) {
      const viewer = terminal.viewers.get(channel);
      if (viewer && viewer.socket === socket) return { terminal, viewer };
    }
    return null;
  }

  function handle(socket: CoreSocket, request: Record<string, unknown>): void {
    const params = isRecord(request.params) ? request.params : {};
    switch (request.method) {
      case "terminal.list": list(socket, request.id); return;
      case "terminal.run": run(socket, request.id, params); return;
      case "terminal.attach": attach(socket, request.id, params); return;
      case "terminal.kill": kill(socket, request.id, params); return;
      default: fail(socket, request.id, "method_not_found");
    }
  }

  function closeSocket(socket: CoreSocket): void {
    if (socket.destroyed) return;
    socket.destroyed = true;
    sockets.delete(socket);
    // The socket's viewers end; terminals keep running for the next connection.
    for (const terminal of terminals.values()) {
      for (const viewer of [...terminal.viewers.values()]) if (viewer.socket === socket) detach(terminal, viewer, false);
    }
    queueMicrotask(() => socket.emit("close"));
  }

  return {
    /** A new connection to this core, as `herdr-core connect` would give. */
    async openStream(): Promise<HcSocket> {
      if (disposed) throw new Error("windows terminals are shut down");
      const socket = new EventEmitter() as CoreSocket;
      socket.destroyed = false;
      const decoder = new HcFrameDecoder();
      let greeted = false;
      let pending = Buffer.alloc(0);
      socket.destroy = () => closeSocket(socket);
      socket.write = (data: Buffer | string) => {
        if (socket.destroyed) return false;
        let bytes = typeof data === "string" ? Buffer.from(data) : data;
        try {
          if (!greeted) {
            pending = Buffer.concat([pending, bytes]);
            const newline = pending.indexOf(10);
            if (newline < 0) { if (pending.length > MAX_HELLO_BYTES) closeSocket(socket); return true; }
            const hello = JSON.parse(pending.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
            greeted = true;
            bytes = pending.subarray(newline + 1);
            pending = Buffer.alloc(0);
            queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: {
              version: WINDOWS_CORE_VERSION, generation: 1, framed: true, features: ["framed", "attach", "shell"], methods: METHODS,
            } })}\n`)));
            if (bytes.length === 0) return true;
          }
          for (const frame of decoder.push(bytes)) {
            if (frame.channel === 0) {
              if (frame.kind !== HC_FRAME.DATA) continue;
              const request = JSON.parse(frame.payload.toString("utf8")) as unknown;
              if (isRecord(request) && typeof request.method === "string") handle(socket, request);
              continue;
            }
            const found = viewerOf(socket, frame.channel);
            if (!found) continue;
            const { terminal, viewer } = found;
            if (frame.kind === HC_FRAME.DATA) { if (!viewer.observe) terminal.pty?.write(frame.payload.toString("latin1")); }
            else if (frame.kind === HC_FRAME.CREDIT && frame.payload.length >= 4) {
              viewer.unacked = Math.max(0, viewer.unacked - frame.payload.readUInt32LE(0));
              flush(terminal, viewer);
            } else if (frame.kind === HC_FRAME.RESIZE && frame.payload.length >= 4 && !viewer.observe) {
              terminal.pty?.resize(Math.max(20, Math.min(500, frame.payload.readUInt16LE(0))), Math.max(5, Math.min(200, frame.payload.readUInt16LE(2))));
            } else if (frame.kind === HC_FRAME.CLOSE) detach(terminal, viewer, false);
          }
        } catch (error: unknown) {
          // Anything unreadable ends this connection; the guard already refused what it could.
          log(`windows core stream refused: ${error instanceof Error ? error.name : "UnknownError"}`);
          closeSocket(socket);
        }
        return true;
      };
      sockets.add(socket);
      return socket;
    },

    /** How many terminals are running (for tests and status). */
    live: (): number => [...terminals.values()].filter((terminal) => terminal.live).length,

    /** The app is quitting: every connection closes and every terminal ends. */
    dispose(): void {
      disposed = true;
      for (const socket of [...sockets]) closeSocket(socket);
      for (const terminal of terminals.values()) {
        try { terminal.pty?.kill(); } catch (error: unknown) {
          log(`terminal end failed: ${error instanceof Error ? error.name : "UnknownError"}`);
        }
      }
      terminals.clear();
    },
  };
}

export type WindowsCore = ReturnType<typeof createWindowsCore>;
