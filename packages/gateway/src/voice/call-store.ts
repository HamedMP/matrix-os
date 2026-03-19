import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { TerminalStates, type CallRecord } from "./types.js";

export class CallStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(record: CallRecord): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }

  getAll(): CallRecord[] {
    if (!existsSync(this.path)) return [];

    const content = readFileSync(this.path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const records: CallRecord[] = [];

    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as CallRecord);
      } catch {
        // Skip corrupted lines
      }
    }

    return records;
  }

  getActive(): CallRecord[] {
    return this.getAll().filter((r) => !TerminalStates.has(r.state));
  }

  getById(callId: string): CallRecord | undefined {
    return this.getAll().find((r) => r.callId === callId);
  }

  update(callId: string, partial: Partial<CallRecord>): void {
    const records = this.getAll();
    const updated = records.map((r) =>
      r.callId === callId ? { ...r, ...partial } : r,
    );
    writeFileSync(
      this.path,
      updated.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  getRecent(limit: number): CallRecord[] {
    const all = this.getAll();
    return all.slice(-limit);
  }
}
