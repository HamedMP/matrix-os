import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface VoiceUsageEntry {
  action: "tts" | "stt" | "call";
  provider: string;
  durationMs?: number;
  chars?: number;
  cost: number;
  direction?: "inbound" | "outbound";
  ts: number;
}

export class VoiceUsageTracker {
  private filePath: string;
  private dirEnsured = false;

  constructor(homePath: string) {
    this.filePath = `${homePath}/system/logs/voice-usage.jsonl`;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.dirEnsured = true;
  }

  track(entry: Omit<VoiceUsageEntry, "ts">): void {
    if (!this.dirEnsured) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.dirEnsured = true;
    }
    const line = JSON.stringify({ ...entry, ts: Date.now() });
    appendFileSync(this.filePath, line + "\n");
  }

  getAll(): VoiceUsageEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  getDaily(date?: string): { tts: number; stt: number; call: number; total: number } {
    const target = date || new Date().toISOString().slice(0, 10);
    const entries = this.getAll().filter(
      (e) => new Date(e.ts).toISOString().slice(0, 10) === target,
    );
    return this.summarize(entries);
  }

  getMonthly(month?: string): { tts: number; stt: number; call: number; total: number } {
    const target = month || new Date().toISOString().slice(0, 7);
    const entries = this.getAll().filter(
      (e) => new Date(e.ts).toISOString().slice(0, 7) === target,
    );
    return this.summarize(entries);
  }

  private summarize(entries: VoiceUsageEntry[]) {
    const tts = entries.filter((e) => e.action === "tts").reduce((sum, e) => sum + e.cost, 0);
    const stt = entries.filter((e) => e.action === "stt").reduce((sum, e) => sum + e.cost, 0);
    const call = entries.filter((e) => e.action === "call").reduce((sum, e) => sum + e.cost, 0);
    return { tts, stt, call, total: tts + stt + call };
  }
}
