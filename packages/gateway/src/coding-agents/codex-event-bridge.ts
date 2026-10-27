import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  AgentThreadSummarySchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { AiTokenUsage } from "../ai-analytics.js";
import { parseCodexExecJsonLine } from "./codex-events.js";
import { completionEvents } from "./codex-terminal-events.js";
import { codexExecContractStatus } from "./codex-version.js";
import { codexAppServerContractStatus } from "./codex-app-server-version.js";
import { CodexExecutableSchema, codexExecutableFromEnv } from "./codex-executable.js";
import type { CodingAgentProviderEventBatch } from "./provider-adapter.js";
import { runtimeUnavailable, type RuntimeSupervision } from "./codex-runtime-supervision.js";
import type { ProviderIdleObservation } from "./provider-transcript-recovery.js";
import type { ProviderObservationResume } from "./provider-transcript-recovery.js";
import { cleanupProviderTranscripts } from "./provider-transcript-retention.js";

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const WatchInputSchema = z.object({
  threadId: AgentThreadSummarySchema.shape.id,
  sessionId: SessionIdSchema,
  startAtEnd: z.boolean().optional(),
  startOffset: z.number().int().min(0).max(16 * 1024 * 1024).optional(),
  checkpoint: z.boolean().optional(),
  generation: z.uuid().optional(),
}).strict();
const MAX_WATCHERS = 100;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_DRAIN_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_CACHE_TTL_MS = 30_000;
const STOP_DRAIN_GRACE_MS = 5_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type VersionCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;
type ProviderEventStore = {
  removeUnreferencedProviderTranscript?(sessionId: string, remove: () => Promise<boolean>): Promise<boolean>;
  prepareProviderObservation?(principal: RequestPrincipal, threadId: string, sessionId: string, resume: ProviderObservationResume): Promise<{ offset: number; generation: string } | undefined>;
  recoverProviderTranscript?(principal: RequestPrincipal, threadId: string, cursor: { sessionId: string; expectedOffset: number; generation?: string },
    proveIdle: (observation: ProviderIdleObservation) => Promise<boolean>): Promise<boolean>;
  ingestProviderEvents(
    principal: RequestPrincipal,
    threadId: string,
    batch: CodingAgentProviderEventBatch,
    cursor?: { sessionId: string; offset: number; generation?: string; checkpoint?: false },
  ): Promise<unknown>;
};
type WatchEntry = {
  watchId: string;
  generation?: string;
  checkpoint?: boolean;
  supervision: RuntimeSupervision;
  failureEvents?: AgentThreadEvent[];
  principal: RequestPrincipal;
  threadId: string;
  sessionId: string;
  path: string;
  offset: number;
  lastTouchedAt: number;
  pendingOccurredAt?: string;
  stopRequestedAt?: number;
  nextDriftCheckAt?: number;
};

const execFileAsync = promisify(execFile);
const defaultVersionCommand: VersionCommand = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    signal: options.signal,
    encoding: "utf-8",
    maxBuffer: 64 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export function codexProviderEventPath(homePath: string, sessionId: string): string {
  const parsed = SessionIdSchema.parse(sessionId);
  return join(resolve(homePath), "system", "coding-agents", "provider-events", `${parsed}.jsonl`);
}

function eventId(sessionId: string, byteOffset: number, index: number, generation?: string): string {
  const digest = createHash("sha256")
    .update(`${sessionId}:${byteOffset}:${index}${generation ? `:${generation}` : ""}`)
    .digest("hex")
    .slice(0, 32);
  return `evt_codex_${digest}`;
}


export function createCodexEventBridge(options: {
  homePath: string;
  runVersionCommand?: VersionCommand;
  codexExecutable?: string;
  pollIntervalMs?: number;
  now?: () => Date;
  nowMs?: () => number;
  isRuntimeAlive?: (sessionId: string) => Promise<boolean>;
  isExecutionIdle?: (observation: ProviderIdleObservation) => Promise<boolean>;
}) {
  const homePath = resolve(options.homePath);
  const eventDir = join(homePath, "system", "coding-agents", "provider-events");
  const runVersionCommand = options.runVersionCommand ?? defaultVersionCommand;
  const codexExecutable = CodexExecutableSchema.parse(
    options.codexExecutable ?? codexExecutableFromEnv(process.env),
  );
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? Date.now;
  const watchers = new Map<string, WatchEntry>();
  let store: ProviderEventStore | undefined;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let lastCleanupAt = 0;
  let versionCache: { ok: boolean; expiresAt: number } | undefined;
  function deleteCurrent(entry: WatchEntry) {
    if (watchers.get(entry.sessionId) === entry) watchers.delete(entry.sessionId);
  }

  async function versionIsVerified(parentSignal?: AbortSignal): Promise<boolean> {
    if (versionCache && versionCache.expiresAt > nowMs()) return versionCache.ok;
    const timeoutSignal = AbortSignal.timeout(VERSION_TIMEOUT_MS);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal;
    let ok = false;
    try {
      const result = await runVersionCommand(codexExecutable, ["--version"], {
        cwd: homePath,
        timeout: VERSION_TIMEOUT_MS,
        signal,
      });
      const versionOutput = result.stdout || result.stderr;
      const execStatus = codexExecContractStatus(versionOutput);
      const appServerStatus = codexAppServerContractStatus(versionOutput);
      ok = execStatus.status === "verified" &&
        appServerStatus.status === "verified" &&
        execStatus.version === appServerStatus.version;
    } catch (error: unknown) {
      if (
        signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        return false;
      }
      console.warn("[coding-agents] Codex version check failed");
    }
    versionCache = { ok, expiresAt: nowMs() + VERSION_CACHE_TTL_MS };
    return ok;
  }

  async function ensureEventDirectory(): Promise<void> {
    await mkdir(eventDir, { recursive: true });
    const canonicalHome = await realpath(homePath);
    const canonicalEventDir = await realpath(eventDir);
    if (canonicalEventDir !== join(canonicalHome, "system", "coding-agents", "provider-events")) {
      throw new Error("Codex event directory is unavailable");
    }
  }

  function evictIfNeeded(): void {
    if (watchers.size < MAX_WATCHERS) return;
    let oldest: WatchEntry | undefined;
    for (const entry of watchers.values()) {
      if (!oldest || entry.lastTouchedAt < oldest.lastTouchedAt) oldest = entry;
    }
    if (oldest) watchers.delete(oldest.sessionId);
  }

  async function cleanupOrphans(): Promise<void> {
    const currentTime = nowMs();
    if (currentTime - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = currentTime;
    await cleanupProviderTranscripts({ directory: eventDir, now: currentTime, hasWatcher: id => watchers.has(id),
      removeUnreferenced: store?.removeUnreferencedProviderTranscript?.bind(store) });
  }

  async function ingest(entry: WatchEntry, bytes: Buffer, consumedBytes: number): Promise<{ terminal: boolean; ready: boolean }> {
    if (!store) throw new Error("Codex event store is unavailable");
    const events: AgentThreadEvent[] = [];
    let providerThreadId: string | undefined;
    let tokenUsage: AiTokenUsage | undefined;
    let terminal = false;
    let ready = false;
    let lineStart = 0;
    let absoluteOffset = entry.offset;
    const occurredAt = entry.pendingOccurredAt ?? now().toISOString();
    entry.pendingOccurredAt = occurredAt;
    while (lineStart < consumedBytes) {
      const newline = bytes.indexOf(0x0a, lineStart);
      if (newline < 0 || newline >= consumedBytes) break;
      const line = bytes.subarray(lineStart, newline).toString("utf-8").replace(/\r$/, "");
      let index = 0;
      const parsed = parseCodexExecJsonLine(line, {
        threadId: entry.threadId,
        now: () => new Date(occurredAt),
        nextEventId: () => eventId(entry.sessionId, absoluteOffset, index++, entry.generation),
      });
      events.push(...parsed.events);
      ready ||= parsed.events.length > 0 || !!parsed.providerThreadId || !!parsed.outcome;
      if (parsed.providerThreadId) {
        if (providerThreadId && providerThreadId !== parsed.providerThreadId) {
          throw new Error("Codex provider conversation changed");
        }
        providerThreadId = parsed.providerThreadId;
      }
      if (parsed.tokenUsage) tokenUsage = parsed.tokenUsage;
      if (parsed.outcome) {
        terminal = true;
        events.push(...completionEvents({
          threadId: entry.threadId,
          outcome: parsed.outcome,
          failureReason: parsed.failureReason,
          occurredAt,
          nextEventId: () => eventId(entry.sessionId, absoluteOffset, index++, entry.generation),
        }));
      }
      absoluteOffset += newline - lineStart + 1;
      lineStart = newline + 1;
      if (entry.checkpoint) {
        await store.ingestProviderEvents(entry.principal, entry.threadId, {
          events: [...events], ...(providerThreadId ? { providerThreadId } : {}),
          ...(parsed.outcome && tokenUsage ? { tokenUsage } : {}),
        }, { sessionId: entry.sessionId, offset: absoluteOffset, ...(entry.generation ? { generation: entry.generation } : {}) });
        events.length = 0;
        providerThreadId = undefined;
        tokenUsage = undefined;
      }
    }

    const chunks: AgentThreadEvent[][] = [];
    for (let index = 0; index < events.length; index += 100) chunks.push(events.slice(index, index + 100));
    if (chunks.length === 0 && providerThreadId) chunks.push([]);
    for (const [index, chunk] of chunks.entries()) {
      await store.ingestProviderEvents(entry.principal, entry.threadId, {
        events: chunk,
        ...(index === 0 && providerThreadId ? { providerThreadId } : {}),
        ...(index === chunks.length - 1 && terminal && tokenUsage ? { tokenUsage } : {}),
      }, { sessionId: entry.sessionId, offset: entry.offset, generation: entry.generation, checkpoint: false });
    }
    return { terminal, ready };
  }

  // True means all complete records were consumed; an incomplete final line is not a durable event.
  async function drainEntry(entry: WatchEntry): Promise<boolean> {
    const stoppedDrainExpired = () =>
      entry.stopRequestedAt !== undefined && nowMs() - entry.stopRequestedAt >= STOP_DRAIN_GRACE_MS;
    let handle;
    try {
      const info = await lstat(entry.path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) {
        deleteCurrent(entry);
        return false;
      }
      if (info.size < entry.offset && options.isExecutionIdle && store?.recoverProviderTranscript
        && nowMs() >= (entry.nextDriftCheckAt ?? 0)) {
        entry.nextDriftCheckAt = nowMs() + 10_000;
        if (await store.recoverProviderTranscript(entry.principal, entry.threadId,
          { sessionId: entry.sessionId, expectedOffset: entry.offset, ...(entry.generation ? { generation: entry.generation } : {}) }, async observation => {
            if (!await options.isExecutionIdle!(observation) || watchers.get(entry.sessionId) !== entry) return false;
            const current = await lstat(entry.path);
            return current.isFile() && !current.isSymbolicLink() && current.size < entry.offset
              && current.dev === info.dev && current.ino === info.ino;
          })) {
          entry.supervision.terminal = true;
          deleteCurrent(entry);
          return true;
        }
      }
      // A bad checkpoint must not fall through retryable generic supervision:
      // uncertain liveness cannot authorize either replay or another prompt.
      if (info.size < entry.offset) return false;
      if (info.size <= entry.offset) {
        if (stoppedDrainExpired()) deleteCurrent(entry);
        return true;
      }
      const length = Math.min(info.size - entry.offset, MAX_DRAIN_BYTES);
      const bytes = Buffer.alloc(length);
      handle = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const read = await handle.read(bytes, 0, length, entry.offset);
      const data = bytes.subarray(0, read.bytesRead);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        if (stoppedDrainExpired()) deleteCurrent(entry);
        return true;
      }
      const consumedBytes = lastNewline + 1;
      if (closed || watchers.get(entry.sessionId) !== entry) return false;
      const { terminal, ready } = await ingest(entry, data, consumedBytes);
      entry.offset += consumedBytes;
      entry.supervision.ready ||= ready;
      entry.supervision.terminal ||= terminal;
      entry.lastTouchedAt = nowMs();
      entry.pendingOccurredAt = undefined;
      if (terminal && entry.stopRequestedAt !== undefined) deleteCurrent(entry);
      return info.size - entry.offset <= data.length - consumedBytes;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        if (stoppedDrainExpired()) deleteCurrent(entry);
        return true;
      }
      console.warn("[coding-agents] Codex event ingestion will retry");
      return false;
    } finally {
      await handle?.close();
    }
  }

  async function drainAll(): Promise<void> {
    if (closed) return;
    await cleanupOrphans();
    const entries = [...watchers.values()];
    for (let start = 0; start < entries.length; start += 10) {
      await Promise.all(entries.slice(start, start + 10).map(async (entry) => {
        await drainEntry(entry);
        if (!store || !options.isRuntimeAlive || watchers.get(entry.sessionId) !== entry) return;
        if (!entry.failureEvents && !await runtimeUnavailable(entry.supervision,
          () => options.isRuntimeAlive!(entry.sessionId), nowMs())) return;
        if (closed || watchers.get(entry.sessionId) !== entry || entry.supervision.terminal) return;
        // A final batch may have arrived during the probe; give persisted output priority.
        if (!await drainEntry(entry)) return;
        if (entry.supervision.terminal || watchers.get(entry.sessionId) !== entry) return;
        entry.failureEvents ??= completionEvents({ threadId: entry.threadId, outcome: "failed",
          occurredAt: now().toISOString(), nextEventId: (() => {
            let index = 0;
            const epoch = randomUUID();
            return () => eventId(`${entry.sessionId}:${epoch}`, entry.offset, 10_000 + index++);
          })(),
        });
        try {
          await store.ingestProviderEvents(entry.principal, entry.threadId, { events: entry.failureEvents },
            { sessionId: entry.sessionId, offset: entry.offset, generation: entry.generation, checkpoint: false });
          deleteCurrent(entry);
        } catch (error: unknown) {
          console.warn("[coding-agents] Runtime failure persistence will retry", {
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }));
    }
  }

  let drainScheduled = false;
  const timer = setInterval(() => {
    if (drainScheduled) return;
    drainScheduled = true;
    queue = queue.then(drainAll, drainAll).finally(() => { drainScheduled = false; });
  }, pollIntervalMs);
  timer.unref();

  return {
    attachThreadStore(nextStore: ProviderEventStore): void {
      store = nextStore;
    },
    async healthCheck(signal?: AbortSignal): Promise<{ ok: boolean }> {
      return { ok: await versionIsVerified(signal) };
    },
    async watch(input: {
      principal: RequestPrincipal;
      threadId: string;
      sessionId: string;
      startAtEnd?: boolean;
      startOffset?: number;
      checkpoint?: boolean;
      generation?: string;
      resume?: ProviderObservationResume;
    }): Promise<{ path: string; offset?: number; generation?: string; watchId?: string }> {
      if (closed || !await versionIsVerified()) {
        throw new Error("Codex structured events are unavailable");
      }
      const parsed = WatchInputSchema.parse({
        threadId: input.threadId,
        sessionId: input.sessionId,
        ...(input.startAtEnd !== undefined ? { startAtEnd: input.startAtEnd } : {}),
        ...(input.startOffset !== undefined ? { startOffset: input.startOffset } : {}),
        ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
      });
      await ensureEventDirectory();
      const path = codexProviderEventPath(homePath, parsed.sessionId);
      const prepared = input.resume ? await store?.prepareProviderObservation?.(input.principal, parsed.threadId, parsed.sessionId, input.resume) : undefined;
      const existing = watchers.get(parsed.sessionId);
      if (existing) {
        if (existing.threadId !== parsed.threadId || existing.principal.userId !== input.principal.userId) {
          throw new Error("Codex event watcher identity mismatch");
        }
        if (!parsed.startAtEnd) { existing.lastTouchedAt = nowMs(); existing.checkpoint ||= parsed.checkpoint; return { path, watchId: existing.watchId, ...(parsed.checkpoint ? { offset: existing.offset } : {}) }; }
      }
      if (!existing) evictIfNeeded();
      // Renew supervision without dropping bytes already owned by an active watcher.
      let offset = prepared?.offset ?? existing?.offset ?? parsed.startOffset ?? 0;
      if (parsed.startAtEnd && !existing) {
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) {
            throw new Error("Codex event transcript is unavailable");
          }
          offset = info.size;
        } catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
            throw error;
          }
        }
      }
      const watchId = randomUUID();
      watchers.set(parsed.sessionId, {
        watchId,
        generation: prepared?.generation ?? parsed.generation ?? existing?.generation,
        checkpoint: parsed.checkpoint ?? existing?.checkpoint,
        supervision: { startedAt: nowMs(), nextProbeAt: nowMs() + 10_000, failures: 0,
          ready: parsed.startOffset !== undefined, terminal: false },
        principal: input.principal,
        threadId: parsed.threadId,
        sessionId: parsed.sessionId,
        path,
        offset,
        lastTouchedAt: nowMs(),
      });
      return { path, watchId, ...(parsed.checkpoint ? { offset } : {}), ...((prepared?.generation ?? parsed.generation) ? { generation: prepared?.generation ?? parsed.generation } : {}) };
    },
    unwatch(sessionId: string, watchId?: string): void {
      if (SessionIdSchema.safeParse(sessionId).success && (!watchId || watchers.get(sessionId)?.watchId === watchId)) watchers.delete(sessionId);
    },
    async isRuntimeAlive(sessionId: string) { return options.isRuntimeAlive?.(sessionId); },
    markStopped(sessionId: string): void {
      if (!SessionIdSchema.safeParse(sessionId).success) return;
      const entry = watchers.get(sessionId);
      if (!entry) return;
      entry.stopRequestedAt = nowMs();
      entry.lastTouchedAt = nowMs();
      queue = queue.then(drainAll, drainAll);
    },
    watcherCount(): number {
      return watchers.size;
    },
    async drain(): Promise<void> {
      queue = queue.then(drainAll, drainAll);
      await queue;
    },
    async shutdown(): Promise<void> {
      if (closed) return;
      clearInterval(timer);
      await queue;
      queue = queue.then(drainAll, drainAll);
      await queue;
      closed = true;
      watchers.clear();
      store = undefined;
      versionCache = undefined;
    },
  };
}

export type CodexEventBridge = ReturnType<typeof createCodexEventBridge>;
