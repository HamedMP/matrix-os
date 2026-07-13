import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  AgentThreadSummarySchema,
  SafeClientErrorSchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { parseCodexExecJsonLine } from "./codex-events.js";
import { codexExecContractStatus } from "./codex-version.js";
import type { CodingAgentProviderEventBatch } from "./provider-adapter.js";

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const WatchInputSchema = z.object({
  threadId: AgentThreadSummarySchema.shape.id,
  sessionId: SessionIdSchema,
}).strict();
const MAX_WATCHERS = 100;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_DRAIN_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_CACHE_TTL_MS = 30_000;
const STOP_DRAIN_GRACE_MS = 5_000;
const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ORPHAN_FILES = 200;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type VersionCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;
type ProviderEventStore = {
  ingestProviderEvents(
    principal: RequestPrincipal,
    threadId: string,
    batch: CodingAgentProviderEventBatch,
  ): Promise<unknown>;
};
type WatchEntry = {
  principal: RequestPrincipal;
  threadId: string;
  sessionId: string;
  path: string;
  offset: number;
  lastTouchedAt: number;
  pendingOccurredAt?: string;
  stopRequestedAt?: number;
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

function eventId(sessionId: string, byteOffset: number, index: number): string {
  const digest = createHash("sha256")
    .update(`${sessionId}:${byteOffset}:${index}`)
    .digest("hex")
    .slice(0, 32);
  return `evt_codex_${digest}`;
}

function completionEvents(input: {
  threadId: string;
  outcome: "completed" | "failed";
  occurredAt: string;
  nextEventId: () => string;
}): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [];
  if (input.outcome === "failed") {
    events.push(AgentThreadEventSchema.parse({
      type: "thread.error",
      eventId: input.nextEventId(),
      threadId: input.threadId,
      occurredAt: input.occurredAt,
      error: SafeClientErrorSchema.parse({
        code: "provider_failed",
        safeMessage: "The coding agent stopped. Review the thread and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      }),
    }));
  }
  events.push(AgentThreadEventSchema.parse({
    type: "thread.completed",
    eventId: input.nextEventId(),
    threadId: input.threadId,
    occurredAt: input.occurredAt,
    outcome: input.outcome,
  }));
  return events;
}

export function createCodexEventBridge(options: {
  homePath: string;
  runVersionCommand?: VersionCommand;
  pollIntervalMs?: number;
  now?: () => Date;
  nowMs?: () => number;
}) {
  const homePath = resolve(options.homePath);
  const eventDir = join(homePath, "system", "coding-agents", "provider-events");
  const runVersionCommand = options.runVersionCommand ?? defaultVersionCommand;
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? Date.now;
  const watchers = new Map<string, WatchEntry>();
  let store: ProviderEventStore | undefined;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let lastCleanupAt = 0;
  let versionCache: { ok: boolean; expiresAt: number } | undefined;

  async function versionIsVerified(parentSignal?: AbortSignal): Promise<boolean> {
    if (versionCache && versionCache.expiresAt > nowMs()) return versionCache.ok;
    let ok = false;
    try {
      const timeoutSignal = AbortSignal.timeout(VERSION_TIMEOUT_MS);
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, timeoutSignal])
        : timeoutSignal;
      const result = await runVersionCommand("codex", ["--version"], {
        cwd: homePath,
        timeout: VERSION_TIMEOUT_MS,
        signal,
      });
      ok = codexExecContractStatus(result.stdout || result.stderr).status === "verified";
    } catch (error: unknown) {
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
    let entries;
    try {
      entries = await readdir(eventDir, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!SessionIdSchema.safeParse(sessionId).success || watchers.has(sessionId)) continue;
      const path = join(eventDir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      files.push({ path, mtimeMs: info.mtimeMs });
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const [index, file] of files.entries()) {
      if (file.mtimeMs > currentTime - ORPHAN_RETENTION_MS && index >= files.length - MAX_ORPHAN_FILES) continue;
      await rm(file.path, { force: true });
    }
  }

  async function ingest(entry: WatchEntry, bytes: Buffer, consumedBytes: number): Promise<boolean> {
    if (!store) throw new Error("Codex event store is unavailable");
    const events: AgentThreadEvent[] = [];
    let providerThreadId: string | undefined;
    let terminal = false;
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
        nextEventId: () => eventId(entry.sessionId, absoluteOffset, index++),
      });
      events.push(...parsed.events);
      if (parsed.providerThreadId) {
        if (providerThreadId && providerThreadId !== parsed.providerThreadId) {
          throw new Error("Codex provider conversation changed");
        }
        providerThreadId = parsed.providerThreadId;
      }
      if (parsed.outcome) {
        terminal = true;
        events.push(...completionEvents({
          threadId: entry.threadId,
          outcome: parsed.outcome,
          occurredAt,
          nextEventId: () => eventId(entry.sessionId, absoluteOffset, index++),
        }));
      }
      absoluteOffset += newline - lineStart + 1;
      lineStart = newline + 1;
    }

    const chunks: AgentThreadEvent[][] = [];
    for (let index = 0; index < events.length; index += 100) chunks.push(events.slice(index, index + 100));
    if (chunks.length === 0 && providerThreadId) chunks.push([]);
    for (const [index, chunk] of chunks.entries()) {
      await store.ingestProviderEvents(entry.principal, entry.threadId, {
        events: chunk,
        ...(index === 0 && providerThreadId ? { providerThreadId } : {}),
      });
    }
    return terminal;
  }

  async function drainEntry(entry: WatchEntry): Promise<void> {
    const stoppedDrainExpired = () =>
      entry.stopRequestedAt !== undefined && nowMs() - entry.stopRequestedAt >= STOP_DRAIN_GRACE_MS;
    let handle;
    try {
      const info = await lstat(entry.path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) {
        watchers.delete(entry.sessionId);
        return;
      }
      if (info.size <= entry.offset) {
        if (stoppedDrainExpired()) watchers.delete(entry.sessionId);
        return;
      }
      const length = Math.min(info.size - entry.offset, MAX_DRAIN_BYTES);
      const bytes = Buffer.alloc(length);
      handle = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const read = await handle.read(bytes, 0, length, entry.offset);
      const data = bytes.subarray(0, read.bytesRead);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        if (stoppedDrainExpired()) watchers.delete(entry.sessionId);
        return;
      }
      const consumedBytes = lastNewline + 1;
      const terminal = await ingest(entry, data, consumedBytes);
      entry.offset += consumedBytes;
      entry.lastTouchedAt = nowMs();
      entry.pendingOccurredAt = undefined;
      if (terminal && entry.stopRequestedAt !== undefined) watchers.delete(entry.sessionId);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        if (stoppedDrainExpired()) watchers.delete(entry.sessionId);
        return;
      }
      console.warn("[coding-agents] Codex event ingestion will retry");
    } finally {
      await handle?.close();
    }
  }

  async function drainAll(): Promise<void> {
    if (closed) return;
    await cleanupOrphans();
    for (const entry of watchers.values()) await drainEntry(entry);
  }

  const timer = setInterval(() => {
    queue = queue.then(drainAll, drainAll);
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
    }): Promise<{ path: string }> {
      if (closed || !await versionIsVerified()) {
        throw new Error("Codex structured events are unavailable");
      }
      const parsed = WatchInputSchema.parse({ threadId: input.threadId, sessionId: input.sessionId });
      await ensureEventDirectory();
      const path = codexProviderEventPath(homePath, parsed.sessionId);
      const existing = watchers.get(parsed.sessionId);
      if (existing) {
        if (existing.threadId !== parsed.threadId || existing.principal.userId !== input.principal.userId) {
          throw new Error("Codex event watcher identity mismatch");
        }
        existing.lastTouchedAt = nowMs();
        return { path };
      }
      evictIfNeeded();
      watchers.set(parsed.sessionId, {
        principal: input.principal,
        threadId: parsed.threadId,
        sessionId: parsed.sessionId,
        path,
        offset: 0,
        lastTouchedAt: nowMs(),
      });
      return { path };
    },
    unwatch(sessionId: string): void {
      if (SessionIdSchema.safeParse(sessionId).success) watchers.delete(sessionId);
    },
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
