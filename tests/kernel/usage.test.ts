import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createUsageTracker, type UsageTracker } from "../../packages/kernel/src/usage.js";

describe("Usage Tracker", () => {
  let tempHome: string;
  let tracker: UsageTracker;

  beforeEach(() => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "usage-")));
    mkdirSync(join(tempHome, "system", "logs"), { recursive: true });
    tracker = createUsageTracker(tempHome);
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("createUsageTracker", () => {
    it("initializes tracker", () => {
      expect(tracker).toBeDefined();
      expect(typeof tracker.track).toBe("function");
      expect(typeof tracker.getDaily).toBe("function");
      expect(typeof tracker.getMonthly).toBe("function");
      expect(typeof tracker.checkLimit).toBe("function");
    });
  });

  describe("track", () => {
    it("records a usage entry", () => {
      tracker.track("image_gen", 0.003);
      const daily = tracker.getDaily();
      expect(daily.total).toBeCloseTo(0.003);
    });

    it("persists to JSONL file", () => {
      tracker.track("image_gen", 0.003);
      const logPath = join(tempHome, "system", "logs", "usage.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const content = readFileSync(logPath, "utf-8").trim();
      const entry = JSON.parse(content);
      expect(entry.action).toBe("image_gen");
      expect(entry.cost).toBe(0.003);
      expect(entry.timestamp).toBeDefined();
    });

    it("appends multiple entries", () => {
      tracker.track("image_gen", 0.003);
      tracker.track("image_gen", 0.003);
      tracker.track("voice_tts", 0.05);

      const logPath = join(tempHome, "system", "logs", "usage.jsonl");
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("includes optional metadata", () => {
      tracker.track("image_gen", 0.003, { model: "flux-schnell", prompt: "sunset" });
      const logPath = join(tempHome, "system", "logs", "usage.jsonl");
      const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
      expect(entry.metadata.model).toBe("flux-schnell");
    });
  });

  describe("getDaily", () => {
    it("returns zero totals when no usage", () => {
      const daily = tracker.getDaily();
      expect(daily.total).toBe(0);
      expect(daily.byAction).toEqual({});
    });

    it("returns totals for today", () => {
      tracker.track("image_gen", 0.003);
      tracker.track("image_gen", 0.003);
      tracker.track("voice_tts", 0.05);

      const daily = tracker.getDaily();
      expect(daily.total).toBeCloseTo(0.056);
      expect(daily.byAction.image_gen).toBeCloseTo(0.006);
      expect(daily.byAction.voice_tts).toBeCloseTo(0.05);
    });

    it("filters by specific date", () => {
      tracker.track("image_gen", 0.003);
      const daily = tracker.getDaily("2020-01-01");
      expect(daily.total).toBe(0);
    });
  });

  describe("getMonthly", () => {
    it("returns totals for current month", () => {
      tracker.track("image_gen", 0.003);
      tracker.track("voice_tts", 0.05);

      const monthly = tracker.getMonthly();
      expect(monthly.total).toBeCloseTo(0.053);
    });

    it("returns zero for different month", () => {
      tracker.track("image_gen", 0.003);
      const monthly = tracker.getMonthly("2020-01");
      expect(monthly.total).toBe(0);
    });
  });

  describe("checkLimit", () => {
    it("allows usage when no limits configured", () => {
      const result = tracker.checkLimit("image_gen");
      expect(result.allowed).toBe(true);
    });

    it("respects daily limit", () => {
      for (let i = 0; i < 10; i++) {
        tracker.track("image_gen", 0.1);
      }

      const result = tracker.checkLimit("image_gen", { dailyLimit: 0.5 });
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0.5);
    });

    it("allows usage within limit", () => {
      tracker.track("image_gen", 0.003);
      const result = tracker.checkLimit("image_gen", { dailyLimit: 1.0 });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });
  });
});
