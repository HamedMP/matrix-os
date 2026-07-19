import { z } from "zod/v4";
import { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ } from "@finnaai/matrix/shell-protocol";
import { ShellReplayBuffer } from "./replay-buffer.js";
import { PendingPersistQueue } from "./output-pipeline.js";
import type { ScrollbackStore } from "./scrollback-store.js";
import { validateSessionName } from "./names.js";
import type { ShellAttachProcess } from "./zellij.js";
import {
  createTerminalOutputCompatStream,
  type TerminalOutputCompatStream,
} from "../terminal-output-compat.js";

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
  /** @deprecated Shared attach output is no longer paused; slow sockets skip frames instead. */
  lowWaterMark?: number;
  /** @deprecated Shared attach output is no longer paused; slow sockets skip frames instead. */
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
  idleAttachGraceMs?: number;
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
  openedAt: number;
  lastActivityAt: number;
  closed: boolean;
  close: () => void;
}

interface SessionRuntime {
  name: string;
  buffer: ShellReplayBuffer;
  queue: PendingPersistQueue | null;
  conns: Set<ConnState>;
  child: ShellAttachProcess | null;
  abortController: AbortController | null;
  dataDisposable: { dispose(): void } | null;
  exitDisposable: { dispose(): void } | null;
  outputCompat: TerminalOutputCompatStream | null;
  attachPromise: Promise<boolean> | null;
  idleCloseTimer: NodeJS.Timeout | null;
  disposed: boolean;
}

export function createShellWsHandler(options: ShellWsHandlerOptions) {
  const maxBuffers = options.maxBuffers ?? 20;
  const maxAttachedClients = options.maxAttachedClients ?? 8;
  const staleAttachTtlMs = options.staleAttachTtlMs ?? 60_000;
  const idleAttachGraceMs = options.idleAttachGraceMs ?? 2_000;
  const highWaterMark = options.flowControl?.highWaterMark ?? 1024 * 1024;

  const runtimes = new Map<string, SessionRuntime>();

  function createQueue(name: string): PendingPersistQueue | null {
    return options.scrollbackStore
      ? new PendingPersistQueue({
          store: options.scrollbackStore,
          sessionName: name,
          flushIntervalMs: options.persistFlushIntervalMs,
          maxPendingBytes: options.maxPendingPersistBytes,
        })
      : null;
  }

  function runtimeFor(name: string): SessionRuntime | null {
    const existing = runtimes.get(name);
    if (existing) {
      runtimes.delete(name);
      runtimes.set(name, existing);
      return existing;
    }
    if (runtimes.size >= maxBuffers) {
      let evicted = false;
      for (const [candidateName, candidate] of runtimes) {
        if (candidate.conns.size === 0) {
          runtimes.delete(candidateName);
          void disposeRuntime(candidate, "evicted runtime flush failed");
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // Hard cap: every tracked session still has live clients, so nothing
        // is safely evictable. Reject instead of growing without bound.
        return null;
      }
    }
    const buffer = new ShellReplayBuffer({
      maxBytes: options.maxReplayBytes,
      scrollbackStore: options.scrollbackStore,
      sessionName: name,
    });
    const runtime: SessionRuntime = {
      name,
      buffer,
      queue: createQueue(name),
      conns: new Set(),
      child: null,
      abortController: null,
      dataDisposable: null,
      exitDisposable: null,
      outputCompat: null,
      attachPromise: null,
      idleCloseTimer: null,
      disposed: false,
    };
    runtimes.set(name, runtime);
    return runtime;
  }

  function canUseRuntime(runtime: SessionRuntime): boolean {
    return !runtime.disposed && runtimes.get(runtime.name) === runtime;
  }

  function canUseAttachPromise(runtime: SessionRuntime, attachPromise: Promise<boolean>): boolean {
    return canUseRuntime(runtime) && runtime.attachPromise === attachPromise;
  }

  function cancelIdleClose(runtime: SessionRuntime): void {
    if (!runtime.idleCloseTimer) {
      return;
    }
    clearTimeout(runtime.idleCloseTimer);
    runtime.idleCloseTimer = null;
  }

  function clearSharedAttach(runtime: SessionRuntime): void {
    cancelIdleClose(runtime);
    runtime.dataDisposable?.dispose();
    runtime.exitDisposable?.dispose();
    runtime.abortController?.abort();
    runtime.dataDisposable = null;
    runtime.exitDisposable = null;
    runtime.abortController = null;
    runtime.child = null;
    runtime.outputCompat = null;
    runtime.attachPromise = null;
  }

  function deliver(conn: ConnState, msg: unknown): boolean {
    if (socketBufferedAmount(conn.ws) > highWaterMark) {
      return false;
    }
    sendJson(conn.ws, msg);
    return true;
  }

  function emitOutput(runtime: SessionRuntime, data: string, finalConn?: ConnState): void {
    if (data.length === 0) {
      return;
    }
    const result = runtime.buffer.writeLive(data);
    const frame = { type: "output", seq: result.seq, data };
    for (const conn of runtime.conns) {
      if (!conn.closed || conn === finalConn) {
        deliver(conn, frame);
      }
    }
    if (result.records.length > 0) {
      runtime.queue?.enqueue(result.records);
    }
  }

  async function flushAndRotateQueue(
    runtime: SessionRuntime,
    warnContext: string,
    recreate: boolean,
  ): Promise<void> {
    const queue = runtime.queue;
    runtime.queue = recreate ? createQueue(runtime.name) : null;
    if (!queue) {
      return;
    }
    await queue.dispose().catch((err: unknown) => {
      console.warn(`[shell] ${warnContext}:`, err instanceof Error ? err.message : String(err));
    });
  }

  async function closeSharedAttach(
    runtime: SessionRuntime,
    warnContext = "final scrollback flush failed",
    recreateQueue = true,
  ): Promise<void> {
    const child = runtime.child;
    if (runtime.outputCompat) {
      emitOutput(runtime, runtime.outputCompat.flush());
    }
    clearSharedAttach(runtime);
    child?.kill();
    await flushAndRotateQueue(runtime, warnContext, recreateQueue);
  }

  function scheduleIdleClose(runtime: SessionRuntime): void {
    if (runtime.conns.size > 0 || runtime.idleCloseTimer) {
      return;
    }
    if (idleAttachGraceMs <= 0) {
      void closeSharedAttach(runtime);
      return;
    }
    runtime.idleCloseTimer = setTimeout(() => {
      runtime.idleCloseTimer = null;
      if (runtime.conns.size === 0) {
        void closeSharedAttach(runtime);
      }
    }, idleAttachGraceMs);
    runtime.idleCloseTimer.unref?.();
  }

  function handleSharedExit(runtime: SessionRuntime, event: { exitCode: number; signal?: number }): void {
    if (runtime.outputCompat) {
      emitOutput(runtime, runtime.outputCompat.flush());
    }
    clearSharedAttach(runtime);
    for (const conn of runtime.conns) {
      if (conn.closed) {
        continue;
      }
      conn.closed = true;
      sendJson(conn.ws, { type: "exit", code: event.exitCode });
    }
    runtime.conns.clear();
    void flushAndRotateQueue(runtime, "final scrollback flush failed", true);
  }

  async function createSeededOutputCompat(
    safeName: string,
    replayBuffer: ShellReplayBuffer,
  ): Promise<TerminalOutputCompatStream> {
    const outputCompat = createTerminalOutputCompatStream({ sessionName: safeName });
    const latestSeq = await replayBuffer.latestSeq();
    const seedFromSeq = latestSeq === null || latestSeq === undefined
      ? 0
      : Math.max(0, latestSeq - SHELL_ATTACH_RECENT_REPLAY_EVENTS + 1);
    for (const event of await replayBuffer.replayFromSeq(seedFromSeq)) {
      if (event.type === "output") {
        outputCompat.write(event.data);
      }
    }
    return outputCompat;
  }

  async function ensureSharedAttach(
    runtime: SessionRuntime,
    safeName: string,
    replayBuffer: ShellReplayBuffer,
  ): Promise<boolean> {
    cancelIdleClose(runtime);
    if (!canUseRuntime(runtime)) {
      return false;
    }
    if (runtime.child) {
      return true;
    }
    if (runtime.attachPromise) {
      return runtime.attachPromise;
    }

    let attachPromise!: Promise<boolean>;
    attachPromise = (async () => {
      const abortController = new AbortController();
      let child: ShellAttachProcess | null = null;
      const outputCompat = await createSeededOutputCompat(safeName, replayBuffer);
      if (!canUseAttachPromise(runtime, attachPromise)) {
        return false;
      }
      runtime.outputCompat = outputCompat;
      // zellij attach can lose the race against the session's own creation
      // (POST /api/terminal/sessions followed immediately by the ws attach, or
      // a cold zellij daemon). Retry briefly before declaring attach_failed so
      // transient startup races do not surface as user-visible errors.
      const maxAttachAttempts = 3;
      for (let attempt = 1; attempt <= maxAttachAttempts; attempt += 1) {
        try {
          child = options.adapter.attachSession(safeName, {
            signal: abortController.signal,
          });
          break;
        } catch (err: unknown) {
          child = null;
          if (attempt >= maxAttachAttempts || !canUseAttachPromise(runtime, attachPromise)) {
            if (canUseAttachPromise(runtime, attachPromise)) {
              runtime.outputCompat = null;
            }
            console.warn("[shell] zellij attach process failed:", err instanceof Error ? err.message : String(err));
            return false;
          }
          console.warn(
            `[shell] zellij attach attempt ${attempt} failed, retrying:`,
            err instanceof Error ? err.message : String(err),
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      if (!child) {
        return false;
      }

      if (!canUseAttachPromise(runtime, attachPromise)) {
        child.kill();
        return false;
      }

      runtime.abortController = abortController;
      runtime.child = child;
      runtime.dataDisposable = child.onData((data: string) => {
        const transformed = runtime.outputCompat?.write(data) ?? data;
        emitOutput(runtime, transformed);
      });
      runtime.exitDisposable = child.onExit((event: { exitCode: number; signal?: number }) => {
        handleSharedExit(runtime, event);
      });
      return true;
    })();

    runtime.attachPromise = attachPromise;
    try {
      return await attachPromise;
    } finally {
      if (runtime.attachPromise === attachPromise) {
        runtime.attachPromise = null;
      }
    }
  }

  async function disposeRuntime(runtime: SessionRuntime, warnContext: string): Promise<void> {
    runtime.disposed = true;
    cancelIdleClose(runtime);
    for (const conn of runtime.conns) {
      conn.closed = true;
      conn.ws.close?.();
    }
    runtime.conns.clear();
    await closeSharedAttach(runtime, warnContext, false);
    if (runtime.queue) {
      await flushAndRotateQueue(runtime, warnContext, false);
    }
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
      // Free the slot synchronously so a concurrent open cannot observe the
      // evicted conn still occupying capacity while its close settles.
      runtime.conns.delete(stalest);
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
    if (!runtime) {
      sendJson(ws, { type: "error", code: "session_capacity", message: "Too many active sessions" });
      ws.close?.();
      return { onMessage: () => undefined, onClose: () => undefined };
    }
    if (!evictStaleOrReject(runtime, ws)) {
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const replayBuffer = runtime.buffer;
    await replayBuffer.ensureSeeded();

    // Re-check capacity: awaits since the first check (seeding, registry
    // list) allow concurrent opens to race the same last slot.
    if (runtime.conns.size >= maxAttachedClients && !evictStaleOrReject(runtime, ws)) {
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    if (!(await ensureSharedAttach(runtime, safeName, replayBuffer))) {
      sendJson(ws, {
        type: "error",
        code: "attach_failed",
        message: "Shell attach failed",
      });
      ws.close?.();
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    // One or more concurrent opens may have filled the final client slot while
    // this call awaited the shared attach startup.
    if (runtime.conns.size >= maxAttachedClients && !evictStaleOrReject(runtime, ws)) {
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const conn: ConnState = {
      ws,
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      closed: false,
      close: () => {
        void closeSession().finally(() => {
          ws.close?.();
        });
      },
    };
    runtime.conns.add(conn);
    cancelIdleClose(runtime);

    const effectiveFromSeq = fromSeq === SHELL_ATTACH_LIVE_TAIL_FROM_SEQ
      ? (await replayBuffer.latestSeq() ?? -1) + 1
      : fromSeq;

    sendJson(ws, {
      type: "attached",
      session: safeName,
      state: info.status === "exited" ? "exited" : "running",
      fromSeq: effectiveFromSeq,
    });

    const replayOutputCompat = createTerminalOutputCompatStream({ sessionName: safeName });
    for (const event of await replayBuffer.replayFromSeq(effectiveFromSeq)) {
      if (event.type === "replay-evicted") {
        continue;
      }
      if (event.type === "output") {
        const data = replayOutputCompat.write(event.data);
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

    const detachConn = () => {
      runtime.conns.delete(conn);
      if (runtime.conns.size === 0) {
        scheduleIdleClose(runtime);
      }
    };

    const closeSession = async () => {
      if (conn.closed) {
        return;
      }
      conn.closed = true;
      const isLastConn = runtime.conns.size === 1 && runtime.conns.has(conn);
      if (isLastConn && idleAttachGraceMs <= 0) {
        if (runtime.outputCompat) {
          const pendingOutput = runtime.outputCompat.flush();
          if (pendingOutput.length > 0) {
            emitOutput(runtime, pendingOutput, conn);
          }
        }
        runtime.conns.delete(conn);
        await closeSharedAttach(runtime);
        return;
      }
      detachConn();
    };

    return {
      onMessage(raw: string) {
        if (conn.closed) {
          return;
        }
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
          runtime.child?.write(msg.data);
          return;
        }
        if (msg.type === "resize") {
          runtime.child?.resize(msg.cols, msg.rows);
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

  async function dispose(): Promise<void> {
    const drains: Array<Promise<void>> = [];
    for (const runtime of runtimes.values()) {
      drains.push(disposeRuntime(runtime, "shutdown scrollback flush failed"));
    }
    await Promise.all(drains);
    runtimes.clear();
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
