import { z } from "zod/v4";
import { SHELL_ATTACH_LIVE_TAIL_FROM_SEQ } from "@finnaai/matrix/shell-protocol";
import { ShellReplayBuffer } from "./replay-buffer.js";
import { PendingPersistQueue } from "./output-pipeline.js";
import type { ScrollbackStore } from "./scrollback-store.js";
import { validateSessionName } from "./names.js";
import { createSessionSizing, type SessionSizing, type ShellClientClass, type TerminalSize } from "./sizing.js";
import { createTerminalLeaseCoordinator } from "./terminal-lease.js";
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
  list(): Promise<Array<{ name: string; status?: "active" | "exited"; canonicalSize?: TerminalSize | null }>>;
}

interface ShellWsAdapter {
  attachSession(name: string, options?: { signal?: AbortSignal; size?: TerminalSize }): ShellAttachProcess;
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
  /** Briefly observe a new PTY for asynchronous zellij startup failures. */
  attachStartupGraceMs?: number;
  flowControl?: ShellWsFlowControlOptions;
  sizingDebounceMs?: number;
  defaultCanonicalSize?: TerminalSize;
  persistCanonicalSize?: (name: string, size: TerminalSize) => void;
  /** Enables exclusive live-renderer takeovers for upgraded clients. */
  leaseCoordinator?: ReturnType<typeof createTerminalLeaseCoordinator>;
}

export interface ShellWsOpenOptions {
  ws: ShellWsSocket;
  session: string;
  fromSeq?: number;
  /** Sizing class (spec 107 FR-007): absent = legacy (pre-upgrade client). */
  clientClass?: Exclude<ShellClientClass, "legacy">;
  declaredSize?: TerminalSize;
  exclusiveLease?: boolean;
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
  id: string;
  exclusiveLease: boolean;
  leaseEpoch: number | null;
  ws: ShellWsSocket;
  openedAt: number;
  lastActivityAt: number;
  closed: boolean;
  close: () => Promise<void>;
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
  sizing: SessionSizing | null;
  cutoverTail: Promise<void>;
  coordinatedOwnership: boolean;
}

export function createShellWsHandler(options: ShellWsHandlerOptions) {
  const leaseCoordinator = options.leaseCoordinator ?? createTerminalLeaseCoordinator();
  const maxBuffers = options.maxBuffers ?? 20;
  const maxAttachedClients = options.maxAttachedClients ?? 8;
  const staleAttachTtlMs = options.staleAttachTtlMs ?? 60_000;
  const idleAttachGraceMs = options.idleAttachGraceMs ?? 2_000;
  const attachStartupGraceMs = options.attachStartupGraceMs ?? 75;
  const earlyAttachOutputLimit = Math.min(options.maxReplayBytes ?? 1024 * 1024, 64 * 1024);
  const highWaterMark = options.flowControl?.highWaterMark ?? 1024 * 1024;

  const runtimes = new Map<string, SessionRuntime>();
  let connCounter = 0;

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
      sizing: null,
      cutoverTail: Promise.resolve(),
      coordinatedOwnership: false,
    };
    runtimes.set(name, runtime);
    return runtime;
  }

  function broadcastCanonicalSize(runtime: SessionRuntime, size: TerminalSize): void {
    const dead: ConnState[] = [];
    for (const conn of runtime.conns) {
      if (!sendJson(conn.ws, { type: "canonical-size", cols: size.cols, rows: size.rows })) {
        dead.push(conn);
      }
    }
    for (const conn of dead) {
      void conn.close();
    }
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

  function stopSharedAttach(runtime: SessionRuntime): void {
    const child = runtime.child;
    if (runtime.outputCompat) {
      emitOutput(runtime, runtime.outputCompat.flush());
    }
    clearSharedAttach(runtime);
    child?.kill();
  }

  async function closeSharedAttach(
    runtime: SessionRuntime,
    warnContext = "final scrollback flush failed",
    recreateQueue = true,
  ): Promise<void> {
    stopSharedAttach(runtime);
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
      if (conn.leaseEpoch !== null) {
        leaseCoordinator.release(runtime.name, conn.id, conn.leaseEpoch);
      }
      sendJson(conn.ws, { type: "exit", code: event.exitCode });
    }
    runtime.conns.clear();
    // Every connection was just cleared without running its detach path, so
    // their sizing registrations would linger. Drop the arbiter so a later
    // reconnect negotiates from fresh declarations instead of stale ones;
    // the persisted canonical size reloads from the registry on next open.
    runtime.sizing?.dispose();
    runtime.sizing = null;
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
            size: runtime.sizing?.spawnSize(),
          });
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
          continue;
        }

        let committed = false;
        let earlyOutputLength = 0;
        const earlyOutput: string[] = [];
        let earlyOutputPaused = false;
        let earlyOutputOverflowed = false;
        let resolveEarlyExit!: (event: { exitCode: number; signal?: number }) => void;
        const earlyExit = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
          resolveEarlyExit = resolve;
        });
        const dataDisposable = child.onData((data: string) => {
          if (committed) {
            const transformed = runtime.outputCompat?.write(data) ?? data;
            emitOutput(runtime, transformed);
            return;
          }
          if (earlyOutputOverflowed) return;
          earlyOutput.push(data);
          earlyOutputLength += data.length;
          if (earlyOutputLength < earlyAttachOutputLimit || earlyOutputPaused) return;
          if (child?.pause) {
            child.pause();
            earlyOutputPaused = true;
            return;
          }
          // A custom adapter without PTY flow control cannot preserve a
          // bounded startup buffer. Fail this attach explicitly rather than
          // acknowledge a connection after silently dropping output.
          earlyOutputOverflowed = true;
          child?.kill();
        });
        const exitDisposable = child.onExit((event: { exitCode: number; signal?: number }) => {
          if (committed) {
            handleSharedExit(runtime, event);
          } else {
            resolveEarlyExit(event);
          }
        });
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        const startupExit = attachStartupGraceMs <= 0
          ? null
          : await Promise.race([
              earlyExit,
              new Promise<null>((resolve) => {
                startupTimer = setTimeout(() => resolve(null), attachStartupGraceMs);
              }),
            ]);
        if (startupTimer !== undefined) clearTimeout(startupTimer);

        if (startupExit || earlyOutputOverflowed) {
          dataDisposable.dispose();
          exitDisposable.dispose();
          if (!startupExit) child.kill();
          child = null;
          if (attempt >= maxAttachAttempts || !canUseAttachPromise(runtime, attachPromise)) {
            if (canUseAttachPromise(runtime, attachPromise)) runtime.outputCompat = null;
            console.warn(
              startupExit
                ? `[shell] zellij attach exited during startup with code ${startupExit.exitCode}`
                : "[shell] zellij attach exceeded the bounded startup buffer without flow control",
            );
            return false;
          }
          console.warn(
            startupExit
              ? `[shell] zellij attach attempt ${attempt} exited during startup, retrying: code ${startupExit.exitCode}`
              : `[shell] zellij attach attempt ${attempt} exceeded the bounded startup buffer, retrying`,
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }

        if (!canUseAttachPromise(runtime, attachPromise)) {
          dataDisposable.dispose();
          exitDisposable.dispose();
          child.kill();
          return false;
        }

        runtime.abortController = abortController;
        runtime.child = child;
        const canonicalSize = runtime.sizing?.current();
        if (canonicalSize) {
          child.resize(canonicalSize.cols, canonicalSize.rows);
        }
        runtime.dataDisposable = dataDisposable;
        runtime.exitDisposable = exitDisposable;
        committed = true;
        for (const data of earlyOutput) {
          const transformed = runtime.outputCompat?.write(data) ?? data;
          emitOutput(runtime, transformed);
        }
        if (earlyOutputPaused) child.resume?.();
        return true;
      }
      return false;
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
    runtime.sizing?.dispose();
    runtime.sizing = null;
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
      void stalest.close();
      return true;
    }
    sendJson(ws, { type: "error", code: "attach_limit", message: "Too many clients attached" });
    ws.close?.();
    return false;
  }

  async function withCutoverLock<T>(runtime: SessionRuntime, operation: () => Promise<T>): Promise<T> {
    const prior = runtime.cutoverTail;
    let release!: () => void;
    runtime.cutoverTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function open({ ws, session, fromSeq = 0, clientClass: openOptionsClass, declaredSize, exclusiveLease = false }: ShellWsOpenOptions): Promise<ShellWsSession> {
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
    const replayBuffer = runtime.buffer;
    if (!runtime.sizing) {
      runtime.sizing = createSessionSizing({
        initialSize: info.canonicalSize ?? null,
        defaultSize: options.defaultCanonicalSize,
        debounceMs: options.sizingDebounceMs,
        onApply: (size) => {
          runtime.child?.resize(size.cols, size.rows);
          broadcastCanonicalSize(runtime, size);
        },
        persist: (size) => {
          options.persistCanonicalSize?.(safeName, size);
        },
      });
    }
    const sizing = runtime.sizing;
    await replayBuffer.ensureSeeded();

    // A hard declaration without a size cannot participate in negotiation;
    // treat it as legacy so it does not disable legacy resize-follow while
    // contributing nothing (review finding on spec 107 FR-007).
    const clientClass: ShellClientClass =
      openOptionsClass === "hard" && !declaredSize ? "legacy" : (openOptionsClass ?? "legacy");
    const connId = `conn-${++connCounter}`;
    let lease: ReturnType<typeof leaseCoordinator.acquire> | null = null;
    let sizingRegistered = false;
    const conn: ConnState = {
      id: connId,
      exclusiveLease: exclusiveLease,
      leaseEpoch: null,
      ws,
      openedAt: Date.now(),
      lastActivityAt: Date.now(),
      closed: false,
      close: () =>
        closeSession().finally(() => {
          ws.close?.();
        }),
    };

    const detachConn = () => {
      runtime.conns.delete(conn);
      if (lease) leaseCoordinator.release(safeName, connId, lease.epoch);
      if (sizingRegistered) {
        sizing.detach(connId);
        sizingRegistered = false;
      }
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
        if (sizingRegistered) {
          sizing.detach(connId);
          sizingRegistered = false;
        }
        if (lease) leaseCoordinator.release(safeName, connId, lease.epoch);
        await closeSharedAttach(runtime);
        return;
      }
      detachConn();
    };

    const sendAttachedAndReplay = async (effectiveFromSeq: number): Promise<void> => {
      sendJson(ws, {
        type: "attached",
        session: safeName,
        state: info.status === "exited" ? "exited" : "running",
        fromSeq: effectiveFromSeq,
        canonicalSize: sizing.current() ?? sizing.spawnSize(),
        ...(lease ? { lease: { epoch: lease.epoch } } : {}),
      });

      const replayOutputCompat = createTerminalOutputCompatStream({ sessionName: safeName });
      for (const event of await replayBuffer.replayFromSeq(effectiveFromSeq)) {
        if (event.type === "replay-evicted") continue;
        if (event.type === "output") {
          const data = replayOutputCompat.write(event.data);
          if (data.length > 0) sendJson(ws, { ...event, data });
          continue;
        }
        sendJson(ws, event);
      }
    };

    const attached = await withCutoverLock(runtime, async () => {
      if (!canUseRuntime(runtime)) return false;
      cancelIdleClose(runtime);

      if (!exclusiveLease && !evictStaleOrReject(runtime, ws)) return false;

      if (exclusiveLease) {
        lease = leaseCoordinator.acquire(safeName, connId, declaredSize ?? sizing.spawnSize());
        runtime.coordinatedOwnership = true;
        conn.leaseEpoch = lease.epoch;
        sizing.attach(connId, clientClass, declaredSize ?? lease.size);
        sizingRegistered = true;
        runtime.conns.add(conn);

        for (const prior of [...runtime.conns]) {
          if (prior === conn) continue;
          sendJson(prior.ws, { type: "lease-revoked", epoch: prior.leaseEpoch });
          // Remove every prior sizing registration before computing the
          // replacement bridge size. Awaiting this makes the cutover ordering
          // explicit instead of relying on closeSession's synchronous prefix.
          await prior.close();
        }

        // The Zellij client owns presentation modes (alternate screen, mouse
        // reporting, cursor state). Rotate it with the lease so the incoming
        // renderer receives a complete fresh bootstrap instead of inheriting
        // an opaque byte-stream tail from the previous renderer.
        stopSharedAttach(runtime);
        options.persistCanonicalSize?.(safeName, lease.size);
        const effectiveFromSeq = (await replayBuffer.latestSeq() ?? -1) + 1;
        await sendAttachedAndReplay(effectiveFromSeq);
        sendJson(ws, { type: "presentation-reset" });
        if (!(await ensureSharedAttach(runtime, safeName, replayBuffer))) {
          detachConn();
          sendJson(ws, { type: "error", code: "attach_failed", message: "Shell attach failed" });
          ws.close?.();
          return false;
        }
        return true;
      }

      // A read-only observer that arrives while a lease exists must not alter
      // canonical sizing merely by declaring itself as a hard client.
      const sizingClass = leaseCoordinator.current(safeName) ? "soft" : clientClass;
      sizing.attach(connId, sizingClass, declaredSize ?? null);
      sizingRegistered = true;
      if (!(await ensureSharedAttach(runtime, safeName, replayBuffer))) {
        sizing.detach(connId);
        sizingRegistered = false;
        sendJson(ws, { type: "error", code: "attach_failed", message: "Shell attach failed" });
        ws.close?.();
        return false;
      }
      if (runtime.conns.size >= maxAttachedClients && !evictStaleOrReject(runtime, ws)) {
        sizing.detach(connId);
        sizingRegistered = false;
        return false;
      }
      runtime.conns.add(conn);
      const effectiveFromSeq = fromSeq === SHELL_ATTACH_LIVE_TAIL_FROM_SEQ
        ? (await replayBuffer.latestSeq() ?? -1) + 1
        : fromSeq;
      await sendAttachedAndReplay(effectiveFromSeq);
      return true;
    });

    if (!attached) {
      return { onMessage: () => undefined, onClose: () => undefined };
    }

    const revokeExpiredHolders = (): void => {
      for (const candidate of [...runtime.conns]) {
        if (!candidate.exclusiveLease || candidate.leaseEpoch === null || candidate.closed) continue;
        sendJson(candidate.ws, { type: "lease-revoked", epoch: candidate.leaseEpoch });
        void candidate.close();
      }
    };

    const currentLeaseOrRevokeExpired = () => {
      const currentLease = leaseCoordinator.current(safeName);
      if (!currentLease && runtime.coordinatedOwnership) revokeExpiredHolders();
      return currentLease;
    };

    const mayMutate = (resize?: TerminalSize): boolean => {
      const currentLease = currentLeaseOrRevokeExpired();
      if (!currentLease) return !runtime.coordinatedOwnership && !conn.exclusiveLease;
      if (currentLease.holderId !== conn.id || currentLease.epoch !== conn.leaseEpoch) return false;
      const renewed = resize
        ? leaseCoordinator.resize(safeName, conn.id, currentLease.epoch, resize) !== null
        : leaseCoordinator.touch(safeName, conn.id, currentLease.epoch);
      if (!renewed) revokeExpiredHolders();
      return renewed;
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
          if (conn.exclusiveLease && !mayMutate()) return;
          if (!conn.exclusiveLease) currentLeaseOrRevokeExpired();
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
          if (!mayMutate()) return;
          runtime.child?.write(msg.data);
          return;
        }
        if (msg.type === "resize") {
          const requested = { cols: msg.cols, rows: msg.rows };
          if (!mayMutate(requested)) return;
          if (clientClass === "hard") {
            // A desktop-web or CLI hard client changed size: update its
            // declaration and let the arbiter re-pin the shared attach pty
            // (spec 107 FR-008/9).
            sizing.declared(connId, requested);
            return;
          }
          if (clientClass === "soft") {
            // Soft viewports render the canonical grid scaled; their resize
            // frames are hints only and never touch the pty.
            return;
          }
          // Legacy clients keep resize-follow behavior only while no
          // classified client is attached (spec 107 FR-007).
          if (sizing.legacyResizeAllowed()) {
            runtime.child?.resize(msg.cols, msg.rows);
          }
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
    leaseCoordinator.dispose();
  }

  return { open, dispose, pendingPersistBytes };
}

function sendJson(ws: ShellWsSocket, msg: unknown): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (err: unknown) {
    console.warn("[shell] terminal websocket send failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
