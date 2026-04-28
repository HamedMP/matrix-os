import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "disp-log-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function readLogEntries(homePath: string) {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(homePath, "system", "logs", `${today}.jsonl`);
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeSpawnWithTokens(cost = 0.05, tokensIn = 1500, tokensOut = 300): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "test-session" } as KernelEvent;
    yield { type: "text", text: "response" } as KernelEvent;
    yield { type: "tool_start", tool: "bash" } as KernelEvent;
    yield { type: "tool_end" } as KernelEvent;
    yield {
      type: "result",
      data: { sessionId: "test-session", cost, turns: 1, tokensIn, tokensOut },
    } as KernelEvent;
  };
}

function failingSpawn(): SpawnFn {
  return async function* (_message, _config) {
    yield { type: "init", sessionId: "fail-session" } as KernelEvent;
    throw new Error("kernel crash");
  };
}

describe("T1352: Dispatcher wires senderId and tokens into logger", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("logs real tokensIn and tokensOut from kernel result", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithTokens(0.05, 2000, 400),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hello", "s1", () => {});

    const entries = readLogEntries(homePath);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(entry.tokensIn).toBe(2000);
    expect(entry.tokensOut).toBe(400);
  });

  it("logs senderId from dispatch context", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithTokens(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("hi", undefined, () => {}, {
      channel: "telegram",
      senderId: "user123",
    });

    const entries = readLogEntries(homePath);
    const entry = entries[entries.length - 1];
    expect(entry.senderId).toBe("user123");
  });

  it("logs model when configured", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithTokens(),
      maxConcurrency: 1,
      model: "claude-opus-4-6",
    });

    await dispatcher.dispatch("hi", undefined, () => {});

    const entries = readLogEntries(homePath);
    const entry = entries[entries.length - 1];
    expect(entry.model).toBe("claude-opus-4-6");
  });
});

describe("T1354: Dispatcher wires structured errors into logger", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("logs structured error with name, message, stack on dispatch failure", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: failingSpawn(),
      maxConcurrency: 1,
    });

    await dispatcher.dispatch("fail", undefined, () => {}).catch(() => {});

    const entries = readLogEntries(homePath);
    const entry = entries[entries.length - 1];
    expect(entry.result).toBe("error");
    expect(entry.error).toBeDefined();
    expect(entry.error.name).toBe("Error");
    expect(entry.error.message).toBe("kernel crash");
    expect(entry.error.stack).toBeDefined();
  });
});

describe("T1355: Batch dispatch logging", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("logs each batch entry as separate JSONL entry with batch flag", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: fakeSpawnWithTokens(0.02, 500, 100),
      maxConcurrency: 1,
    });

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "build app1", onEvent: () => {} },
      { taskId: "t2", message: "build app2", onEvent: () => {} },
    ]);

    const entries = readLogEntries(homePath);
    const batchEntries = entries.filter((e: Record<string, unknown>) => e.batch === true);
    expect(batchEntries.length).toBe(2);
    expect(batchEntries[0].batchId).toBeDefined();
    expect(batchEntries[0].batchId).toBe(batchEntries[1].batchId);
    expect(batchEntries[0].tokensIn).toBe(500);
  });

  it("logs failed batch entries with error details", async () => {
    const failSpawn: SpawnFn = async function* (_message, _config) {
      yield { type: "init", sessionId: "s1" } as KernelEvent;
      throw new Error("batch item failed");
    };

    const dispatcher = createDispatcher({
      homePath,
      spawnFn: failSpawn,
      maxConcurrency: 1,
    });

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "fail", onEvent: () => {} },
    ]);

    const entries = readLogEntries(homePath);
    const errorEntries = entries.filter((e: Record<string, unknown>) => e.result === "error");
    expect(errorEntries.length).toBeGreaterThanOrEqual(1);
    expect(errorEntries[0].batch).toBe(true);
    expect(errorEntries[0].error).toBeDefined();
    expect(errorEntries[0].error.message).toBe("batch item failed");
  });
});

describe("Dispatcher Claude auth environment", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("prefers a Claude OAuth login in the Matrix home over the platform proxy key", async () => {
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "595e4216-edcf-4fa3-80ed-8e2e2e6b9d9c",
          emailAddress: "user@example.com",
        },
      }),
      "utf-8",
    );
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const previousHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = "sk-proxy-hamedmp";
    process.env.ANTHROPIC_BASE_URL = "http://proxy:8080";
    process.env.HOME = "/root";

    let observedEnv: Record<string, string | undefined> | undefined;
    const spawn: SpawnFn = async function* (_message, config) {
      observedEnv = config.env;
      yield { type: "init", sessionId: "oauth-session" } as KernelEvent;
      yield {
        type: "result",
        data: { sessionId: "oauth-session", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0 },
      } as KernelEvent;
    };

    try {
      const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });
      await dispatcher.dispatch("hello", undefined, () => {});
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    expect(observedEnv?.HOME).toBe(homePath);
    expect(observedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(observedEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
