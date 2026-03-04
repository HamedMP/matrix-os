import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createInteractionLogger,
  type InteractionInput,
  type InteractionEntry,
} from "../../packages/gateway/src/logger.js";

function makeTempHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "logger-enh-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function readLastEntry(homePath: string): InteractionEntry {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
  const lines = readFileSync(logFile, "utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("T1351: Enhanced interaction log schema", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("records tokensIn and tokensOut from kernel result", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 1500,
      tokensOut: 300,
      costUsd: 0.05,
      durationMs: 2000,
      result: "ok",
    });

    const entry = readLastEntry(homePath);
    expect(entry.tokensIn).toBe(1500);
    expect(entry.tokensOut).toBe(300);
  });

  it("records senderId from dispatch context", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "telegram",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      durationMs: 1000,
      result: "ok",
      senderId: "user123",
    });

    const entry = readLastEntry(homePath);
    expect(entry.senderId).toBe("user123");
  });

  it("records model and agentName", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      durationMs: 1000,
      result: "ok",
      model: "claude-opus-4-6",
      agentName: "builder",
    });

    const entry = readLastEntry(homePath);
    expect(entry.model).toBe("claude-opus-4-6");
    expect(entry.agentName).toBe("builder");
  });

  it("handles missing optional fields gracefully (defaults to undefined)", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 500,
      result: "ok",
    });

    const entry = readLastEntry(homePath);
    expect(entry.tokensIn).toBe(0);
    expect(entry.tokensOut).toBe(0);
    expect(entry.senderId).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.agentName).toBeUndefined();
  });

  it("JSONL entry has all required fields including timestamp", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "test prompt",
      toolsUsed: ["bash", "write"],
      tokensIn: 2000,
      tokensOut: 500,
      costUsd: 0.08,
      durationMs: 3000,
      result: "ok",
      senderId: "user1",
      model: "claude-opus-4-6",
      agentName: "builder",
    });

    const entry = readLastEntry(homePath);
    expect(entry.timestamp).toBeDefined();
    expect(entry.source).toBe("web");
    expect(entry.sessionId).toBe("s1");
    expect(entry.prompt).toBe("test prompt");
    expect(entry.toolsUsed).toEqual(["bash", "write"]);
    expect(entry.tokensIn).toBe(2000);
    expect(entry.tokensOut).toBe(500);
    expect(entry.costUsd).toBe(0.08);
    expect(entry.durationMs).toBe(3000);
    expect(entry.result).toBe("ok");
    expect(entry.senderId).toBe("user1");
    expect(entry.model).toBe("claude-opus-4-6");
    expect(entry.agentName).toBe("builder");
  });

  it("old log entries without new fields are still parseable via query", () => {
    const logger = createInteractionLogger(homePath);
    // Simulate an old entry without the new fields
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
    const oldEntry = JSON.stringify({
      source: "web",
      sessionId: "old-session",
      prompt: "old prompt",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      durationMs: 100,
      result: "ok",
      timestamp: new Date().toISOString(),
    });
    const { writeFileSync } = require("node:fs");
    writeFileSync(logFile, oldEntry + "\n");

    const entries = logger.query({ date: today });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("web");
    expect(entries[0].senderId).toBeUndefined();
  });
});

describe("T1353: Tool execution logging", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("stores rich tool array with name, durationMs, inputPreview, and status", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      durationMs: 1000,
      result: "ok",
      tools: [
        { name: "bash", durationMs: 500, inputPreview: "ls -la", status: "ok" },
        { name: "write", durationMs: 200, inputPreview: "file_path: /tmp/test.txt", status: "ok" },
      ],
    });

    const entry = readLastEntry(homePath);
    expect(entry.tools).toHaveLength(2);
    expect(entry.tools![0].name).toBe("bash");
    expect(entry.tools![0].durationMs).toBe(500);
    expect(entry.tools![0].inputPreview).toBe("ls -la");
    expect(entry.tools![0].status).toBe("ok");
  });

  it("truncates tool input preview to 500 chars", () => {
    const logger = createInteractionLogger(homePath);
    const longInput = "x".repeat(600);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "hello",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      durationMs: 1000,
      result: "ok",
      tools: [
        { name: "bash", durationMs: 100, inputPreview: longInput, status: "ok" },
      ],
    });

    const entry = readLastEntry(homePath);
    expect(entry.tools![0].inputPreview.length).toBeLessThanOrEqual(503);
  });
});

describe("T1354: Structured error logging", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("captures structured error with name, message, and truncated stack", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "fail",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 100,
      result: "error",
      error: {
        name: "TypeError",
        message: "Cannot read property 'x' of undefined",
        stack: "TypeError: Cannot read property...\n  at Object.<anonymous>",
      },
    });

    const entry = readLastEntry(homePath);
    expect(entry.error).toBeDefined();
    expect(entry.error!.name).toBe("TypeError");
    expect(entry.error!.message).toBe("Cannot read property 'x' of undefined");
    expect(entry.error!.stack).toBeDefined();
  });

  it("truncates error stack to 1000 chars", () => {
    const logger = createInteractionLogger(homePath);
    const longStack = "at ".repeat(500);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "fail",
      toolsUsed: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 100,
      result: "error",
      error: {
        name: "Error",
        message: "boom",
        stack: longStack,
      },
    });

    const entry = readLastEntry(homePath);
    expect(entry.error!.stack!.length).toBeLessThanOrEqual(1003);
  });

  it("log entry is still written on error (with partial data)", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "partial fail",
      toolsUsed: ["bash"],
      tokensIn: 100,
      tokensOut: 0,
      costUsd: 0.001,
      durationMs: 50,
      result: "error",
      error: {
        name: "Error",
        message: "kernel crash",
      },
    });

    const entry = readLastEntry(homePath);
    expect(entry.result).toBe("error");
    expect(entry.prompt).toBe("partial fail");
    expect(entry.toolsUsed).toContain("bash");
    expect(entry.error!.message).toBe("kernel crash");
  });
});

describe("T1355: Batch dispatch logging", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("logs batch entry with batch flag and batchId", () => {
    const logger = createInteractionLogger(homePath);
    logger.log({
      source: "web",
      sessionId: "s1",
      prompt: "batch item 1",
      toolsUsed: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      durationMs: 500,
      result: "ok",
      batch: true,
      batchId: "batch-123",
    });

    const entry = readLastEntry(homePath);
    expect(entry.batch).toBe(true);
    expect(entry.batchId).toBe("batch-123");
  });
});
