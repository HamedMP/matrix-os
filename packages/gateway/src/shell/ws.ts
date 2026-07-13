import { z } from "zod/v4";
import { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ } from "@finnaai/matrix/shell-protocol";
import { ShellReplayBuffer } from "./replay-buffer.js";
import { PendingPersistQueue } from "./output-pipeline.js";
import type { ScrollbackStore } from "./scrollback-store.js";
import { validateSessionName } from "./names.js";
import type { ShellAttachProcess } from "./zellij.js";
import { createTerminalOutputCompatStream } from "../terminal-output-compat.js";

const ShellWsInputSchema = z.object({
  type: z.literal("input"),
  data: z.string().max(65_536),
});

const ShellWsResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

const ShellWsDetachSchema = z.object({
  type: z.literal("detach"),
});

const ShellWsDestroySchema = z.object({
  type: z.literal("destroy"),
});

const ShellWsPingSchema = z.object({
  type: z.literal("ping"),
});

const ShellWsClientMessageSchema = z.union([
  ShellWsInputSchema,
  ShellWsResizeSchema,
  ShellWsDetachSchema,
  ShellWsDestroySchema,
  ShellWsPingSchema,
]);

export { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ };
export const SHELL_ATTACH_RECENT_REPLAY_EVENTS = 50;

export interface ShellWsSocket {
  send(data: string): void;
  close?: () => void;
  /** Backpressure signal; Hono WSContext exposes it on the raw socket. */
  bufferedAmount?: number;
  raw?: { bufferedAmount?: number };
}

interface ShellWsRegistry {
  list(): Promise<Array<{ name: string; status?: "active" | "exited" }>>;
}

interface ShellWsAdapter {
  attachSession(name: string, options?: { signal?: AbortSignal }): ShellAttachProcess;
}

export interface ShellWsFlowControlOptions {
  highWaterMark?: number;
  lowWaterMark?: number;
  drainIntervalMs?: number;
}

export interface ShellWsHandlerOptions {
  registry: ShellWsRegistry;
  adapter: ShellWsAdapter;
  scrollbackStore?: ScrollbackStore;
  maxReplayBytes?: number;
  maxBuffers?: number;
  persistFlushIntervalMs?: number;
  maxPendingPersistBytes?: number;
  maxAttachedClients?: number;
  staleAttachTtlMs?: number;
  flowControl?: ShellWsFlowControlOptions;
}

export interface ShellWsOpenOptions {
  ws: ShellWsSocket;
  session: string;
  fromSeq?: number;
}

export interface ShellWsSession {
  onMessage(raw: string): void;
  onClose(): void;
}

export function shellWsMessageDataToString(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

function socketBufferedAmount(ws: ShellWsSocket): number {
  if (typeof ws.bufferedAmount === "number") {
    return ws.bufferedAmount;
  }
  const raw = ws.raw;
  if (raw && typeof raw.bufferedAmount === "number") {
    return raw.bufferedAmount;
  }
  return 0;
}

interface ConnState {
  ws: ShellWsSocket;
  child: ShellAttachProcess;
  openedAt: number;
  lastActivityAt: number;
  paused: boolean;
  closed: boolean;
  close: () => void;
}

interface SessionRuntime {
  buffer: ShellReplayBuffer;
  queue: PendingPersistQueue | null;
  conns: Set<ConnState>;
  recorder: ConnState | null;
}

export function createShellWsHandler(options: ShellWsHandlerOptions) {
  const maxBuffers = options.maxBuffers ?? 20;
  const maxAttachedClients = options.maxAttachedClients ?? 8;
  const staleAttachTtlMs = options.staleAttachTtlMs ?? 60_000;
  const highWaterMark = options.flowControl?.highWaterMark ?? 1024 * 1024;
  const lowWaterMark = options.flowControl?.lowWaterMark ?? 256 * 1024;
  const drainIntervalMs = options.flowControl?.drainIntervalMs ?? 500;

  const runtimes = new Map<string, SessionRuntime>();
  let drainTimer: NodeJS.Timeout | null = null;

  function runtimeFor(name: string): SessionRuntime {
    const existing = runtimes.get(name);
    if (existing) {
      runtimes.delete(name);
      runtimes.set(name, existing);
      return existing;
    }
    if (runtimes.size >= maxBuffers) {
      for (const [candidateName, candidate] of runtimes) {
        if (candidate.conns.size === 0) {
          runtimes.delete(candidateName);
          void candidate.queue?.dispose();
          break;
        }
      }
    }
    const buffer = new ShellReplayBuffer({
      maxBytes: options.maxReplayBytes,
      scrollbackStore: options.scrollbackStore,
      sessionName: name,
    });
    const queue = options.scrollbackStore
      ? new PendingPersistQueue({
          store: options.scrollbackStore,
          sessionName: name,
          flushIntervalMs: options.persistFlushIntervalMs,
          maxPendingBytes: options.maxPendingPersistBytes,
        })
      : null;
    const runtime: SessionRuntime = { buffer, queue, conns: new Set(), recorder: null };
    runtimes.set(name, runtime);
    return runtime;
  }

  function electRecorder(runtime: SessionRuntime, exclude?: ConnState): void {
    let oldest: ConnState | null = null;
    for (const conn of runtime.conns) {
      if (conn === exclude || conn.closed) {
        continue;
      }
      if (!oldest || conn.openedAt < oldest.openedAt) {
        oldest = conn;
      }
    }
    runtime.recorder = oldest;
  }

  function ensureDrainTimer(): void {
    if (drainTimer) {
      return;
    }
    drainTimer = setInterval(() => {
      let anyPaused = false;
      for (const runtime of runtimes.values()) {
        for (const conn of runtime.conns) {
          if (!conn.paused) {
            continue;
          }
          if (socketBufferedAmount(conn.ws) <= lowWaterMark) {
            conn.paused = false;
            conn.child.resume?.();
          } else {
            anyPaused = true;
          }
        }
      }
      if (!anyPaused && drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
    }, drainIntervalMs);
    drainTimer.unref?.();
  }

  /**
   * Deliver a frame with backpressure. Returns false when the frame was
   * skipped because the socket is over the high-water mark and the connection
   * cannot be paused (a sole recorder must keep producing for persistence).
   */
  function deliver(runtime: SessionRuntime, conn: ConnState, msg: unknown): boolean {
    if (socketBufferedAmount(conn.ws) > highWaterMark) {
      if (runtime.recorder === conn && runtime.conns.size > 1) {
        electRecorder(runtime, conn);
      }
      if (runtime.recorder !== conn) {
        if (!conn.paused) {
          conn.paused = true;
          conn.child.pause?.();
          ensureDrainTimer();
        }
        return false;
      }
      // Sole recorder: never pause the stream that feeds persistence; skip
      // delivery to the saturated socket instead. The client recovers via
      // seq-based replay on drain/reconnect.
      return false;
    }
    sendJson(conn.ws, msg);
    return true;
  }

  function evictStaleOrReject(runtime: SessionRuntime, ws: ShellWsSocket): boolean {
    if (runtime.conns.size < maxAttachedClients) {
      return true;
    }
    const now = Date.now();
    let stalest: ConnState | null = null;
    for (const conn of runtime.conns) {
      if (now - conn.lastActivityAt < staleAttachTtlMs) {
        continue;
      }
      if (!stalest || conn.lastActivityAt < stalest.lastActivityAt) {
        stalest = conn;
      }
    }
    if (stalest) {
      stalest.close();
      return true;
    }
    sendJson(ws, { type: "error", code: "attach_limit", message: "Too many clients attached" });
    ws.close?.();
    return false;
  }

  async function open({ ws, session, fromSeq = 0 }: ShellWsOpenOptions): Promise<ShellWsSession> {
    const safeName = validateSessionName(session);
    const sessions = await options.registry.list();
    const info = sessions.find((candidate) => candidate.name === safeName);
    if (!info) {
      sendJson(ws, {
        type: "error",
        code: "session_not_found",
        message: "Session not found",
      });
      ws.close?.();
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const runtime = runtimeFor(safeName);
    if (!evictStaleOrReject(runtime, ws)) {
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const abortController = new AbortController();
    const replayBuffer = runtime.buffer;
    await replayBuffer.ensureSeeded();
    let child: ShellAttachProcess;
    try {
      child = options.adapter.attachSession(safeName, {
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      console.warn("[shell] zellij attach process failed:", err instanceof Error ? err.message : String(err));
      sendJson(ws, {
        type: "error",
        code: "attach_failed",
        message: "Shell attach failed",
      });
      ws.close?.();
      return { onMessage: () => undefined, onClose: () => undefined };
    }
    let dataDisposable: { dispose(): void } | null = null;
    let exitDisposable: { dispose(): void } | null = null;
    const cleanupProcessListeners = () => {
      dataDisposable?.dispose();
      exitDisposable?.dispose();
      dataDisposable = null;
      exitDisposable = null;
    };

    const conn: ConnState = {
      ws,
      child,
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      paused: false,
      closed: false,
      close: () => {
        void closeSession().finally(() => {
          ws.close?.();
        });
      },
    };
    runtime.conns.add(conn);
    if (!runtime.recorder) {
      runtime.recorder = conn;
    }

    const effectiveFromSeq = fromSeq === SHELL_ATTACH_LIVE_TAIL_FROM_SEQ
      ? Math.max(0, (await replayBuffer.latestSeq() ?? 0) - SHELL_ATTACH_RECENT_REPLAY_EVENTS + 1)
      : fromSeq;

    sendJson(ws, {
      type: "attached",
      session: safeName,
      state: info.status === "exited" ? "exited" : "running",
      fromSeq: effectiveFromSeq,
    });

    const outputCompat = createTerminalOutputCompatStream({ sessionName: safeName });
    for (const event of await replayBuffer.replayFromSeq(effectiveFromSeq)) {
      if (event.type === "replay-evicted") {
        continue;
      }
      if (event.type === "output") {
        const data = outputCompat.write(event.data);
        if (data.length > 0) {
          sendJson(ws, { ...event, data });
        }
        // A replay chunk can contain only the start of an escape sequence. The
        // compat stream buffers it and emits bytes with the later completing
        // chunk, matching the live-output path even when delivered seqs skip.
        continue;
      }
      sendJson(ws, event);
    }

    // Send-first live output: the frame is delivered immediately with a
    // synchronously assigned seq; only the elected recorder's stream feeds the
    // replay buffer and the coalesced persistence queue (spec 107 FR-001/004).
    const emitOutput = (data: string) => {
      if (data.length === 0) {
        return;
      }
      if (runtime.recorder === conn) {
        const result = replayBuffer.writeLive(data);
        deliver(runtime, conn, { type: "output", seq: result.seq, data });
        if (result.records.length > 0) {
          runtime.queue?.enqueue(result.records);
        }
        return;
      }
      deliver(runtime, conn, { type: "output", seq: replayBuffer.lastSeq, data });
    };
    const onData = (data: string) => {
      emitOutput(outputCompat.write(data));
    };
    const detachConn = () => {
      runtime.conns.delete(conn);
      if (runtime.recorder === conn) {
        electRecorder(runtime, conn);
      }
      if (runtime.conns.size === 0 && runtime.queue) {
        // Nobody attached: persist promptly instead of waiting for the timer.
        void runtime.queue.dispose().catch((err: unknown) => {
          console.warn("[shell] final scrollback flush failed:", err instanceof Error ? err.message : String(err));
        });
        runtime.queue = options.scrollbackStore
          ? new PendingPersistQueue({
              store: options.scrollbackStore,
              sessionName: safeName,
              flushIntervalMs: options.persistFlushIntervalMs,
              maxPendingBytes: options.maxPendingPersistBytes,
            })
          : null;
      }
    };

    const onExit = (event: { exitCode: number }) => {
      if (conn.closed) {
        return;
      }
      conn.closed = true;
      cleanupProcessListeners();
      // Flush while this conn still holds its recorder role so trailing
      // output is persisted, then hand the role off.
      emitOutput(outputCompat.flush());
      sendJson(ws, { type: "exit", code: event.exitCode });
      detachConn();
    };
    dataDisposable = child.onData(onData);
    exitDisposable = child.onExit(onExit);

    const closeSession = async () => {
      if (conn.closed) {
        return;
      }
      conn.closed = true;
      emitOutput(outputCompat.flush());
      detachConn();
      abortController.abort();
      cleanupProcessListeners();
      child.kill();
    };

    return {
      onMessage(raw: string) {
        conn.lastActivityAt = Date.now();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err: unknown) {
          console.warn("[shell] invalid terminal websocket JSON:", err instanceof Error ? err.message : String(err));
          sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid message" });
          return;
        }

        const result = ShellWsClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid message" });
          return;
        }

        const msg = result.data;
        if (msg.type === "ping") {
          sendJson(ws, { type: "pong" });
          return;
        }
        if (msg.type === "detach" || msg.type === "destroy") {
          void closeSession().finally(() => {
            ws.close?.();
          });
          return;
        }
        if (msg.type === "input") {
          child.write(msg.data);
          return;
        }
        if (msg.type === "resize") {
          child.resize(msg.cols, msg.rows);
        }
      },
      onClose() {
        void closeSession();
      },
    };
  }

  function pendingPersistBytes(): number {
    let total = 0;
    for (const runtime of runtimes.values()) {
      total += runtime.queue?.pendingBytes ?? 0;
    }
    return total;
  }

  function dispose(): void {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    for (const runtime of runtimes.values()) {
      void runtime.queue?.dispose();
    }
  }

  return { open, dispose, pendingPersistBytes };
}

function sendJson(ws: ShellWsSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (err: unknown) {
    console.warn("[shell] terminal websocket send failed:", err instanceof Error ? err.message : String(err));
  }
}
