import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { VoiceUsageTracker, type VoiceUsageEntry } from "../../../packages/gateway/src/voice/usage.js";

describe("voice/usage", () => {
  let tmpDir: string;
  let tracker: VoiceUsageTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "voice-usage-"));
    tracker = new VoiceUsageTracker(tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("track", () => {
    it("appends entry to JSONL file", () => {
      vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
      tracker.track({ action: "tts", provider: "elevenlabs", chars: 100, cost: 0.03 });

      const filePath = join(tmpDir, "system/logs/voice-usage.jsonl");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8").trim();
      const entry = JSON.parse(content);
      expect(entry.action).toBe("tts");
      expect(entry.provider).toBe("elevenlabs");
      expect(entry.chars).toBe(100);
      expect(entry.cost).toBe(0.03);
      expect(entry.ts).toBe(new Date("2026-03-16T10:00:00Z").getTime());
    });

    it("creates directory at construction time", () => {
      const dirPath = join(tmpDir, "system/logs");
      expect(existsSync(dirPath)).toBe(true);
    });

    it("appends multiple entries", () => {
      tracker.track({ action: "tts", provider: "elevenlabs", chars: 50, cost: 0.015 });
      tracker.track({ action: "stt", provider: "whisper", durationMs: 5000, cost: 0.006 });
      tracker.track({ action: "call", provider: "twilio", durationMs: 60000, cost: 0.02, direction: "outbound" });

      const entries = tracker.getAll();
      expect(entries).toHaveLength(3);
    });
  });

  describe("getAll", () => {
    it("returns all entries", () => {
      tracker.track({ action: "tts", provider: "openai", chars: 200, cost: 0.003 });
      tracker.track({ action: "stt", provider: "whisper", cost: 0.006 });

      const entries = tracker.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe("tts");
      expect(entries[1].action).toBe("stt");
    });

    it("returns empty array when file does not exist", () => {
      const freshTracker = new VoiceUsageTracker(join(tmpDir, "nonexistent"));
      expect(freshTracker.getAll()).toEqual([]);
    });

    it("skips corrupted lines", () => {
      const logsDir = join(tmpDir, "system/logs");
      mkdirSync(logsDir, { recursive: true });
      const filePath = join(logsDir, "voice-usage.jsonl");
      writeFileSync(
        filePath,
        '{"action":"tts","provider":"openai","cost":0.003,"ts":1}\n' +
          "not-json\n" +
          '{"action":"stt","provider":"whisper","cost":0.006,"ts":2}\n',
      );

      const entries = tracker.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe("tts");
      expect(entries[1].action).toBe("stt");
    });
  });

  describe("getDaily", () => {
    it("filters by date and summarizes costs", () => {
      vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
      tracker.track({ action: "tts", provider: "elevenlabs", chars: 100, cost: 0.03 });
      tracker.track({ action: "stt", provider: "whisper", cost: 0.006 });
      tracker.track({ action: "call", provider: "twilio", cost: 0.02, direction: "inbound" });

      vi.setSystemTime(new Date("2026-03-17T10:00:00Z"));
      tracker.track({ action: "tts", provider: "openai", chars: 50, cost: 0.001 });

      const summary = tracker.getDaily("2026-03-16");
      expect(summary.tts).toBeCloseTo(0.03);
      expect(summary.stt).toBeCloseTo(0.006);
      expect(summary.call).toBeCloseTo(0.02);
      expect(summary.total).toBeCloseTo(0.056);
    });

    it("defaults to today when no date provided", () => {
      vi.setSystemTime(new Date("2026-03-16T14:00:00Z"));
      tracker.track({ action: "tts", provider: "edge", chars: 100, cost: 0 });

      const summary = tracker.getDaily();
      expect(summary.tts).toBe(0);
      expect(summary.total).toBe(0);
    });
  });

  describe("getMonthly", () => {
    it("filters by month and summarizes costs", () => {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      tracker.track({ action: "tts", provider: "elevenlabs", chars: 100, cost: 0.03 });

      vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));
      tracker.track({ action: "call", provider: "twilio", cost: 0.02 });

      vi.setSystemTime(new Date("2026-04-01T10:00:00Z"));
      tracker.track({ action: "tts", provider: "openai", chars: 50, cost: 0.001 });

      const marchSummary = tracker.getMonthly("2026-03");
      expect(marchSummary.tts).toBeCloseTo(0.03);
      expect(marchSummary.call).toBeCloseTo(0.02);
      expect(marchSummary.total).toBeCloseTo(0.05);

      const aprilSummary = tracker.getMonthly("2026-04");
      expect(aprilSummary.tts).toBeCloseTo(0.001);
      expect(aprilSummary.total).toBeCloseTo(0.001);
    });
  });
});
