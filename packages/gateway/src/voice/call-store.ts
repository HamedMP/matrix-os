import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { TerminalStates, type CallRecord } from "./types.js";

export class CallStore {
  private readonly path: string;
  private cache: Map<string, CallRecord>;

  constructor(path: string) {
    this.path = path;
    this.cache = new Map();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.path)) return;

    const content = readFileSync(this.path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as CallRecord;
        this.cache.set(record.callId, record);
      } catch {
        // Skip corrupted lines
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
    appendFileSync(this.path, JSON.stringify(record) + "\n");
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
    appendFileSync(this.path, JSON.stringify(updated) + "\n");
  }

  getRecent(limit: number): CallRecord[] {
    const all = this.getAll();
    return all.slice(-limit);
  }
}
