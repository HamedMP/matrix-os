import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createInteractionLogger,
  type InteractionLogger,
  type InteractionEntry,
} from "../../packages/gateway/src/logger.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "logger-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

describe("T200: Interaction logger", () => {
  let homePath: string;
  let logger: InteractionLogger;

  beforeEach(() => {
    homePath = tmpHome();
    logger = createInteractionLogger(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("logs an interaction to daily JSONL file", () => {
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "Hello",
      toolsUsed: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.003,
      durationMs: 500,
      result: "ok",
    });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.source).toBe("web");
    expect(entry.prompt).toBe("Hello");
    expect(entry.tokensIn).toBe(100);
  });

  it("appends multiple entries to same file", () => {
    logger.log({ source: "web", sessionId: "s1", prompt: "A", toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 100, result: "ok" });
    logger.log({ source: "telegram", sessionId: "s2", prompt: "B", toolsUsed: ["bash"], tokensIn: 20, tokensOut: 10, costUsd: 0.002, durationMs: 200, result: "ok" });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("truncates long prompts", () => {
    const longPrompt = "x".repeat(2000);
    logger.log({ source: "web", sessionId: "s1", prompt: longPrompt, toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 100, result: "ok" });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(entry.prompt.length).toBeLessThan(2000);
    expect(entry.prompt).toContain("...");
  });

  it("includes timestamp in each entry", () => {
    logger.log({ source: "web", sessionId: "s1", prompt: "A", toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 100, result: "ok" });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(entry.timestamp).toBeDefined();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("query returns entries for today", () => {
    logger.log({ source: "web", sessionId: "s1", prompt: "A", toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 100, result: "ok" });
    logger.log({ source: "telegram", sessionId: "s2", prompt: "B", toolsUsed: [], tokensIn: 20, tokensOut: 10, costUsd: 0.002, durationMs: 200, result: "error" });

    const today = new Date().toISOString().slice(0, 10);
    const entries = logger.query({ date: today });
    expect(entries).toHaveLength(2);
  });

  it("query filters by source", () => {
    logger.log({ source: "web", sessionId: "s1", prompt: "A", toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 100, result: "ok" });
    logger.log({ source: "telegram", sessionId: "s2", prompt: "B", toolsUsed: [], tokensIn: 20, tokensOut: 10, costUsd: 0.002, durationMs: 200, result: "ok" });

    const today = new Date().toISOString().slice(0, 10);
    const entries = logger.query({ date: today, source: "telegram" });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("telegram");
  });

  it("totalCost sums all entries for today", () => {
    logger.log({ source: "web", sessionId: "s1", prompt: "A", toolsUsed: [], tokensIn: 10, tokensOut: 5, costUsd: 0.01, durationMs: 100, result: "ok" });
    logger.log({ source: "web", sessionId: "s2", prompt: "B", toolsUsed: [], tokensIn: 20, tokensOut: 10, costUsd: 0.02, durationMs: 200, result: "ok" });

    const today = new Date().toISOString().slice(0, 10);
    const cost = logger.totalCost(today);
    expect(cost).toBeCloseTo(0.03);
  });

  it("handles missing log file gracefully", () => {
    const entries = logger.query({ date: "2020-01-01" });
    expect(entries).toEqual([]);
    const cost = logger.totalCost("2020-01-01");
    expect(cost).toBe(0);
  });
});
