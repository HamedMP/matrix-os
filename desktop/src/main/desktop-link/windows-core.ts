// Terminals for the desktop link on Windows (spec 2716), where herdr-core has
// no build. A small in-process core speaks the part of herdr-core's framed
// protocol that the computer's Herdr adapter uses (hello, terminal.list,
// terminal.run, terminal.attach, terminal.kill, and the stream frames), over
// ConPTY through node-pty. Every byte the computer sends still passes the
// desktop link guard first. Bounded: terminals, viewers, a parsed screen with scrollback and
// queued output all have caps; every terminal ends when the app quits.
import { EventEmitter } from "node:events";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { windowsQuoted } from "./consent";

const { Terminal: HeadlessTerminal } = headless;

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

/** node-pty's spawn: `args` as one command line, used as written (node-pty's own form for that). */
export type SpawnWindowsPty = (file: string, args: string, options: {
  name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConpty: boolean;
}) => WindowsPty;

export const WINDOWS_CORE_VERSION = "0.1.22";
const METHODS = ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"];
const MAX_LIVE_TERMINALS = 16;
const MAX_RECORDS = 64;
const MAX_VIEWERS_PER_TERMINAL = 8;
/** Scrollback lines kept per terminal, beside its current screen, for a new viewer's replay. */
const SCROLLBACK_LINES = 1000;
/** Unacknowledged output per viewer before the program is paused. */
const CREDIT_WINDOW = 1024 * 1024;
/** Output queued for a viewer that has run out of credit; past this the viewer is dropped. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
/**
 * How long one slow viewer may hold the program paused. A paused program stops
 * producing, so a stalled viewer's backlog stops growing and would never reach
 * MAX_QUEUED_BYTES: after this, viewers still behind are dropped and it resumes.
 */
const MAX_PAUSE_MS = 10_000;
const MAX_HELLO_BYTES = 64 * 1024;
const POWERSHELL = "powershell.exe";

interface Viewer {
  channel: number; socket: CoreSocket; observe: boolean; unacked: number; queued: Buffer[]; queuedBytes: number;
  /** Typing arrives as UTF-8; a character split across frames is kept until its last byte. */
  decoder: TextDecoder;
}
interface Terminal {
  id: string; title: string; cwd: string; pty: WindowsPty | null; live: boolean; exitCode: number | null;
  /** The terminal's screen as a viewer would see it, kept parsed, so a replay is whole however long it ran. */
  screen: Screen; viewers: Map<number, Viewer>; paused: boolean;
  /** Ends a pause that lasts too long (MAX_PAUSE_MS); set only while paused. */
  pauseTimer: ReturnType<typeof setTimeout> | null;
  labels: Record<string, string>;
  /** When it started: with the address, what tells it from a later terminal at the same address. */
  createdMs: number;
}

type CoreSocket = EventEmitter & HcSocket & { destroyed: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Screen {
  write(chunk: Buffer): void;
  resize(cols: number, rows: number): void;
  /** The current screen and its scrollback as bytes that redraw it, plus output not parsed yet. */
  snapshot(): Buffer;
  dispose(): void;
}

/** A terminal's screen kept by a headless xterm, bounded by its scrollback. */
function createScreen(cols: number, rows: number): Screen {
  const terminal = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer as never);
  // xterm parses asynchronously: output written but not parsed yet goes after the snapshot.
  const unparsed: Buffer[] = [];
  let disposed = false;
  return {
    write(chunk) {
      if (disposed) return;
      unparsed.push(chunk);
      terminal.write(chunk, () => { unparsed.shift(); });
    },
    resize(nextCols, nextRows) { if (!disposed) terminal.resize(nextCols, nextRows); },
    snapshot() {
      if (disposed) return Buffer.alloc(0);
      return Buffer.concat([Buffer.from(serializer.serialize({ scrollback: SCROLLBACK_LINES }), "utf8"), ...unparsed]);
    },
    dispose() { if (!disposed) { disposed = true; terminal.dispose(); } },
  };
}

export function createWindowsCore(options: {
  spawn: SpawnWindowsPty;
  home: string;
  env: Record<string, string>;
  log?: (message: string) => void;
  /** Replaced in tests. */
  maxPauseMs?: number;
}) {
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  const maxPauseMs = options.maxPauseMs ?? MAX_PAUSE_MS;
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
    if (!terminal.paused && terminal.pty) {
      terminal.pty.pause();
      terminal.paused = true;
      terminal.pauseTimer = setTimeout(() => {
        terminal.pauseTimer = null;
        // Whoever is still behind has stalled: they go, everyone else keeps the program running.
        for (const stalled of [...terminal.viewers.values()]) if (stalled.queued.length > 0) detach(terminal, stalled, true);
      }, maxPauseMs);
      terminal.pauseTimer.unref?.();
    }
  }

  function resume(terminal: Terminal): void {
    if (terminal.pauseTimer) { clearTimeout(terminal.pauseTimer); terminal.pauseTimer = null; }
    if (!terminal.paused) return;
    terminal.paused = false;
    terminal.pty?.resume();
  }

  function flush(terminal: Terminal, viewer: Viewer): void {
    while (viewer.queued.length > 0 && viewer.unacked + viewer.queued[0]!.length <= CREDIT_WINDOW) {
      const chunk = viewer.queued.shift()!;
      viewer.queuedBytes -= chunk.length;
      viewer.unacked += chunk.length;
      send(viewer.socket, viewer.channel, HC_FRAME.DATA, chunk);
    }
    const behind = [...terminal.viewers.values()].some((other) => other.queued.length > 0);
    if (!behind) resume(terminal);
  }

  function detach(terminal: Terminal, viewer: Viewer, tell: boolean): void {
    if (!terminal.viewers.delete(viewer.channel)) return;
    if (tell) send(viewer.socket, viewer.channel, HC_FRAME.CLOSE, Buffer.alloc(0));
    if (![...terminal.viewers.values()].some((other) => other.queued.length > 0)) resume(terminal);
  }

  function resize(terminal: Terminal, cols: number, rows: number): void {
    terminal.pty?.resize(cols, rows);
    terminal.screen.resize(cols, rows);
  }

  function forget(terminal: Terminal): void {
    terminals.delete(terminal.id);
    terminal.screen.dispose();
  }

  function prune(): void {
    while (terminals.size > MAX_RECORDS) {
      const oldest = [...terminals.values()].find((terminal) => !terminal.live);
      if (!oldest) return;
      forget(oldest);
    }
  }

  /** The program a run asks for: PowerShell by default, a PowerShell command line, or argv as given. */
  /**
   * The program and its command line, built with the same quoting the owner's
   * approval showed (`windowsQuoted`), so the program reads exactly those arguments.
   */
  function program(params: Record<string, unknown>): { file: string; args: string; title: string } | null {
    const argv = params.argv;
    if (Array.isArray(argv) && argv.length > 0) {
      if (!argv.every((part): part is string => typeof part === "string")) return null;
      // node-pty quotes the program itself, and only for spaces: a quote in it could not be shown as it runs.
      if (argv[0]!.includes('"')) return null;
      return { file: argv[0]!, args: argv.slice(1).map(windowsQuoted).join(" "), title: argv[0]! };
    }
    if (typeof params.line === "string" && params.line.length > 0) {
      return { file: POWERSHELL, args: `-NoLogo -Command ${windowsQuoted(params.line)}`, title: params.line.slice(0, 64) };
    }
    return { file: POWERSHELL, args: "-NoLogo", title: "PowerShell" };
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
      screen: createScreen(cols, rows), viewers: new Map(), paused: false, pauseTimer: null, labels, createdMs: Date.now(),
    };
    terminals.set(address, terminal);
    pty.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      terminal.screen.write(chunk);
      for (const viewer of [...terminal.viewers.values()]) deliver(terminal, viewer, chunk);
    });
    pty.onExit(({ exitCode }) => {
      terminal.live = false;
      terminal.exitCode = exitCode;
      terminal.pty = null;
      // A finished terminal is never attached again: its screen goes now.
      terminal.screen.dispose();
      for (const viewer of [...terminal.viewers.values()]) detach(terminal, viewer, true);
      prune();
    });
    reply(socket, id, { result: { address, state: "live", cwd, labels, created_ms: terminal.createdMs } });
  }

  function attach(socket: CoreSocket, id: unknown, params: Record<string, unknown>): void {
    const terminal = typeof params.terminal === "string" ? terminals.get(params.terminal) : undefined;
    if (!terminal) { fail(socket, id, "not_found"); return; }
    if (!terminal.live) { fail(socket, id, "finished"); return; }
    if (terminal.viewers.size >= MAX_VIEWERS_PER_TERMINAL) { fail(socket, id, "busy"); return; }
    const channel = nextChannel++;
    const viewer: Viewer = { channel, socket, observe: params.observe === true, unacked: 0, queued: [], queuedBytes: 0, decoder: new TextDecoder("utf-8") };
    terminal.viewers.set(channel, viewer);
    if (!viewer.observe && typeof params.cols === "number" && typeof params.rows === "number" && terminal.pty) {
      resize(terminal, Math.max(20, Math.min(500, Math.trunc(params.cols))), Math.max(5, Math.min(200, Math.trunc(params.rows))));
    }
    // As herdr-core does: the terminal attached, so the guard can check it is the one the owner approved.
    reply(socket, id, { result: { channel, resize_notifications: false, automatic_input: false, terminal: {
      address: terminal.id, state: "live", cwd: terminal.cwd, labels: terminal.labels, created_ms: terminal.createdMs,
    } } });
    // The replay, then live output, under the same credit rules.
    deliver(terminal, viewer, terminal.screen.snapshot());
  }

  function kill(socket: CoreSocket, id: unknown, params: Record<string, unknown>): void {
    const terminal = typeof params.terminal === "string" ? terminals.get(params.terminal) : undefined;
    if (!terminal) { fail(socket, id, "not_found"); return; }
    forget(terminal);
    for (const viewer of [...terminal.viewers.values()]) detach(terminal, viewer, true);
    try { terminal.pty?.kill(); } catch (error: unknown) {
      log(`terminal end failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    }
    reply(socket, id, { result: {} });
  }

  function list(socket: CoreSocket, id: unknown): void {
    reply(socket, id, { result: { terminals: [...terminals.values()].map((terminal) => ({
      address: terminal.id, state: terminal.live ? "live" : "finished", title: terminal.title, name: terminal.title,
      status: null, labels: terminal.labels, exit_code: terminal.exitCode, created_ms: terminal.createdMs, cwd: terminal.cwd,
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
            if (frame.kind === HC_FRAME.DATA) {
              if (!viewer.observe) { const text = viewer.decoder.decode(frame.payload, { stream: true }); if (text) terminal.pty?.write(text); }
            }
            else if (frame.kind === HC_FRAME.CREDIT && frame.payload.length >= 4) {
              viewer.unacked = Math.max(0, viewer.unacked - frame.payload.readUInt32LE(0));
              flush(terminal, viewer);
            } else if (frame.kind === HC_FRAME.RESIZE && frame.payload.length >= 4 && !viewer.observe) {
              if (terminal.pty) resize(terminal, Math.max(20, Math.min(500, frame.payload.readUInt16LE(0))), Math.max(5, Math.min(200, frame.payload.readUInt16LE(2))));
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
        if (terminal.pauseTimer) { clearTimeout(terminal.pauseTimer); terminal.pauseTimer = null; }
        try { terminal.pty?.kill(); } catch (error: unknown) {
          log(`terminal end failed: ${error instanceof Error ? error.name : "UnknownError"}`);
        }
        terminal.screen.dispose();
      }
      terminals.clear();
    },
  };
}

export type WindowsCore = ReturnType<typeof createWindowsCore>;
