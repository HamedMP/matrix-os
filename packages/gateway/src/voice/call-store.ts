import {
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { TerminalStates, type CallRecord } from "./types.js";

const COMPACTION_THRESHOLD = 100;
const appendFileNow = fs.appendFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;
const writeFileNow = fs.writeFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;
const renameNow = fs.renameSync as (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
const unlinkNow = fs.unlinkSync as (path: fs.PathLike) => void;

export class CallStore {
  private readonly path: string;
  private cache: Map<string, CallRecord>;
  private appendsSinceCompaction = 0;

  constructor(path: string) {
    this.path = path;
    this.cache = new Map();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const tmp = this.path + ".tmp";
    if (existsSync(tmp)) {
      if (existsSync(this.path)) {
        try {
          unlinkNow(tmp);
        } catch (err: unknown) {
          console.warn("[voice-call-store] Could not remove stale temp file:", err instanceof Error ? err.message : String(err));
        }
      } else {
        try {
          renameNow(tmp, this.path);
        } catch (err: unknown) {
          console.warn("[voice-call-store] Could not recover temp file:", err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (!existsSync(this.path)) return;

    const content = readFileSync(this.path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as CallRecord;
        this.cache.set(record.callId, record);
      } catch (err: unknown) {
        console.warn("[voice-call-store] Skipping corrupted line:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(record: CallRecord): void {
    this.ensureDir();
    this.cache.set(record.callId, record);
    try {
      appendFileNow(this.path, JSON.stringify(record) + "\n");
    } catch (err: unknown) {
      console.warn("[voice-call-store] Could not append call record:", err instanceof Error ? err.message : String(err));
    }
    this.appendsSinceCompaction++;
    this.maybeCompact();
  }

  getAll(): CallRecord[] {
    return Array.from(this.cache.values());
  }

  getActive(): CallRecord[] {
    return this.getAll().filter((r) => !TerminalStates.has(r.state));
  }

  getById(callId: string): CallRecord | undefined {
    return this.cache.get(callId);
  }

  update(callId: string, partial: Partial<CallRecord>): void {
    const existing = this.cache.get(callId);
    if (!existing) return;

    const updated = { ...existing, ...partial };
    this.cache.set(callId, updated);
    this.ensureDir();
    try {
      appendFileNow(this.path, JSON.stringify(updated) + "\n");
    } catch (err: unknown) {
      console.warn("[voice-call-store] Could not append call update:", err instanceof Error ? err.message : String(err));
    }
    this.appendsSinceCompaction++;
    this.maybeCompact();
  }

  getRecent(limit: number): CallRecord[] {
    const all = this.getAll();
    all.sort((a, b) => b.startedAt - a.startedAt);
    return all.slice(0, limit);
  }

  compact(): void {
    this.ensureDir();
    const lines = Array.from(this.cache.values())
      .map((r) => JSON.stringify(r))
      .join("\n");
    const tmp = this.path + ".tmp";
    try {
      writeFileNow(tmp, lines ? lines + "\n" : "");
      renameNow(tmp, this.path);
    } catch (err: unknown) {
      console.warn("[voice-call-store] Could not compact call store:", err instanceof Error ? err.message : String(err));
    }
    this.appendsSinceCompaction = 0;
  }

  private maybeCompact(): void {
    if (this.appendsSinceCompaction >= COMPACTION_THRESHOLD) {
      this.compact();
    }
  }
}
