import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { WorkspaceError } from "./project-manager.js";

export interface TranscriptEntry {
  seq: number;
  sessionId: string;
  timestamp: string;
  data: string;
  bytes: number;
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const TranscriptEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: SessionIdSchema,
  timestamp: z.string().min(1).max(64),
  data: z.string(),
  bytes: z.number().int().nonnegative(),
});

const DEFAULT_HOT_LINE_LIMIT = 10_000;
const DEFAULT_HOT_BYTE_LIMIT = 5 * 1024 * 1024;
const DEFAULT_RETENTION_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_HOT_SESSIONS = 100;

interface HotState {
  entries: TranscriptEntry[];
  bytes: number;
  nextSeq: number;
  truncated: boolean;
  lastAccessedAt: number;
  queue: Promise<unknown>;
}

interface TranscriptFile {
  path: string;
  relativePath: string;
  sessionId: string;
  bytes: number;
  firstTimestamp: string | null;
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function transcriptPath(homePath: string, sessionId: string): string {
  return join(homePath, "system", "session-output", `${sessionId}.jsonl`);
}

function parseJsonl(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = TranscriptEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch (err: unknown) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  try {
    return parseJsonl(await readFile(path, "utf-8"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, value, { flag: "wx" });
    await rename(tmpPath, path);
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

function firstTimestamp(entries: TranscriptEntry[]): string | null {
  return entries.length > 0 ? entries[0]!.timestamp : null;
}

function olderThan(timestamp: string | null, cutoffMs: number): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed < cutoffMs;
}

function appendToHotState(state: HotState, entry: TranscriptEntry, limits: { hotLineLimit: number; hotByteLimit: number }): void {
  state.entries.push(entry);
  state.bytes += entry.bytes;
  state.nextSeq = Math.max(state.nextSeq, entry.seq + 1);
  state.lastAccessedAt = Date.now();
  while (state.entries.length > limits.hotLineLimit || state.bytes > limits.hotByteLimit) {
    const removed = state.entries.shift();
    if (!removed) break;
    state.bytes -= removed.bytes;
    state.truncated = true;
  }
}

function buildState(entries: TranscriptEntry[], limits: { hotLineLimit: number; hotByteLimit: number }): HotState {
  const state: HotState = {
    entries: [],
    bytes: 0,
    nextSeq: entries.reduce((max, entry) => Math.max(max, entry.seq + 1), 0),
    truncated: false,
    lastAccessedAt: Date.now(),
    queue: Promise.resolve(),
  };
  for (const entry of entries) {
    appendToHotState(state, entry, limits);
  }
  if (state.entries.length < entries.length) state.truncated = true;
  return state;
}

export function createSessionTranscriptManager(options: {
  homePath: string;
  now?: () => string;
  hotLineLimit?: number;
  hotByteLimit?: number;
  retentionBytes?: number;
  retentionDays?: number;
  maxHotSessions?: number;
}): {
  append: (
    sessionId: string,
    data: string,
  ) => Promise<{ ok: true; seq: number; path: string } | Failure>;
  getHotReplay: (
    sessionId: string,
    input?: { fromSeq?: number },
  ) => Promise<{ ok: true; fromSeq: number; toSeq: number; truncated: boolean; entries: TranscriptEntry[] } | Failure>;
  rehydrate: (
    sessionId: string,
  ) => Promise<{ ok: true; entriesLoaded: number; hotEntries: number; nextSeq: number; truncated: boolean } | Failure>;
  exportTranscript: (
    sessionId: string,
  ) => Promise<{ ok: true; sessionId: string; relativePath: string; bytes: number; entries: number } | Failure>;
  applyRetention: (
    input?: { now?: string },
  ) => Promise<{ deleted: string[]; truncated: string[]; bytesBefore: number; bytesAfter: number }>;
  totalTranscriptBytes: () => Promise<number>;
} {
  const homePath = resolve(options.homePath);
  const outputDir = join(homePath, "system", "session-output");
  const hotLineLimit = options.hotLineLimit ?? DEFAULT_HOT_LINE_LIMIT;
  const hotByteLimit = options.hotByteLimit ?? DEFAULT_HOT_BYTE_LIMIT;
  const retentionBytes = options.retentionBytes ?? DEFAULT_RETENTION_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxHotSessions = options.maxHotSessions ?? DEFAULT_MAX_HOT_SESSIONS;
  const hot = new Map<string, HotState>();

  function evictHotSessionsIfNeeded(): void {
    while (hot.size > maxHotSessions) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [sessionId, state] of hot.entries()) {
        if (state.lastAccessedAt < oldestAccess) {
          oldestAccess = state.lastAccessedAt;
          oldestKey = sessionId;
        }
      }
      if (!oldestKey) return;
      hot.delete(oldestKey);
    }
  }

  async function stateFor(sessionId: string): Promise<HotState> {
    const existing = hot.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }
    const entries = await readTranscript(transcriptPath(homePath, sessionId));
    const state = buildState(entries, { hotLineLimit, hotByteLimit });
    hot.set(sessionId, state);
    evictHotSessionsIfNeeded();
    return state;
  }

  async function listTranscriptFiles(): Promise<TranscriptFile[]> {
    let entries;
    try {
      entries = await readdir(outputDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const files: TranscriptFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!SessionIdSchema.safeParse(sessionId).success) continue;
      const path = join(outputDir, entry.name);
      const info = await stat(path);
      const transcript = await readTranscript(path);
      files.push({
        path,
        relativePath: relative(homePath, path),
        sessionId,
        bytes: info.size,
        firstTimestamp: firstTimestamp(transcript),
      });
    }
    return files;
  }

  async function totalTranscriptBytes(): Promise<number> {
    const files = await listTranscriptFiles();
    return files.reduce((total, file) => total + file.bytes, 0);
  }

  async function rewriteFileWithNewestEntries(file: TranscriptFile, targetBytes: number): Promise<boolean> {
    const entries = await readTranscript(file.path);
    let bytes = 0;
    const kept: TranscriptEntry[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const lineBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
      if (kept.length > 0 && bytes + lineBytes > targetBytes) break;
      kept.unshift(entry);
      bytes += lineBytes;
    }
    if (kept.length === entries.length) return false;
    const content = kept.map((entry) => JSON.stringify(entry)).join("\n");
    await atomicWriteText(file.path, content.length > 0 ? `${content}\n` : "");
    hot.delete(file.sessionId);
    return true;
  }

  return {
    async append(sessionId, data) {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const state = await stateFor(sessionId);
      const path = transcriptPath(homePath, sessionId);
      const run = async () => {
        const entry: TranscriptEntry = {
          seq: state.nextSeq,
          sessionId,
          timestamp: nowIso(options.now),
          data,
          bytes: Buffer.byteLength(data),
        };
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
        appendToHotState(state, entry, { hotLineLimit, hotByteLimit });
        return { ok: true as const, seq: entry.seq, path };
      };
      state.queue = state.queue.then(run, run);
      return state.queue as Promise<{ ok: true; seq: number; path: string }>;
    },

    async getHotReplay(sessionId, input = {}) {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const fromSeq = input.fromSeq ?? 0;
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
        return failure(400, "invalid_replay_cursor", "Replay cursor is invalid");
      }
      const state = await stateFor(sessionId);
      const entries = state.entries.filter((entry) => entry.seq >= fromSeq);
      return {
        ok: true,
        fromSeq,
        toSeq: state.nextSeq,
        truncated: state.truncated,
        entries,
      };
    },

    async rehydrate(sessionId) {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const entries = await readTranscript(transcriptPath(homePath, sessionId));
      const state = buildState(entries, { hotLineLimit, hotByteLimit });
      hot.set(sessionId, state);
      evictHotSessionsIfNeeded();
      return {
        ok: true,
        entriesLoaded: entries.length,
        hotEntries: state.entries.length,
        nextSeq: state.nextSeq,
        truncated: state.truncated,
      };
    },

    async exportTranscript(sessionId) {
      if (!SessionIdSchema.safeParse(sessionId).success) {
        return failure(400, "invalid_session_id", "Session identifier is invalid");
      }
      const path = transcriptPath(homePath, sessionId);
      if (!await pathExists(path)) {
        return failure(404, "not_found", "Transcript was not found");
      }
      const info = await stat(path);
      const entries = await readTranscript(path);
      return {
        ok: true,
        sessionId,
        relativePath: relative(homePath, path),
        bytes: info.size,
        entries: entries.length,
      };
    },

    async applyRetention(input = {}) {
      const nowMs = Date.parse(input.now ?? nowIso(options.now));
      const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
      const bytesBefore = await totalTranscriptBytes();
      const deleted: string[] = [];
      const truncated: string[] = [];

      for (const file of await listTranscriptFiles()) {
        if (!olderThan(file.firstTimestamp, cutoffMs)) continue;
        await rm(file.path, { force: true });
        hot.delete(file.sessionId);
        deleted.push(file.relativePath);
      }

      let files = await listTranscriptFiles();
      let currentBytes = files.reduce((total, file) => total + file.bytes, 0);
      while (currentBytes > retentionBytes && files.length > 0) {
        files.sort((a, b) => {
          const aTime = a.firstTimestamp ? Date.parse(a.firstTimestamp) : Number.POSITIVE_INFINITY;
          const bTime = b.firstTimestamp ? Date.parse(b.firstTimestamp) : Number.POSITIVE_INFINITY;
          return aTime - bTime;
        });
        const target = files[0]!;
        const overage = currentBytes - retentionBytes;
        const targetBytes = Math.max(0, target.bytes - overage);
        const changed = await rewriteFileWithNewestEntries(target, targetBytes);
        if (!changed) {
          await rm(target.path, { force: true });
          hot.delete(target.sessionId);
          deleted.push(target.relativePath);
        } else {
          truncated.push(target.relativePath);
        }
        files = await listTranscriptFiles();
        currentBytes = files.reduce((total, file) => total + file.bytes, 0);
      }

      return {
        deleted,
        truncated,
        bytesBefore,
        bytesAfter: currentBytes,
      };
    },

    totalTranscriptBytes,
  };
}
