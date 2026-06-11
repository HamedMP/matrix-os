import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  AI_GENERATION_EVENT,
  createAiGenerationRecorder,
  sanitizeAiTraceId,
  type AiCaptureFn,
} from "../../packages/gateway/src/ai-analytics.js";
import { createDispatcher, type SpawnFn } from "../../packages/gateway/src/dispatcher.js";
import type { KernelEvent } from "@matrix-os/kernel";

type CapturedCall = {
  event: string;
  options: { distinctId?: string; properties?: Record<string, unknown> };
};

function makeCapture(): { calls: CapturedCall[]; capture: AiCaptureFn } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    capture: (event, options) => {
      calls.push({ event, options: options as CapturedCall["options"] });
      return Promise.resolve(true);
    },
  };
}

const TRACE_ID_PATTERN = /^[a-zA-Z0-9\-_~.@()!':|]+$/;

describe("sanitizeAiTraceId", () => {
  it("keeps PostHog-allowed characters untouched", () => {
    const id = "abc-DEF_123~.@()!':|";
    expect(sanitizeAiTraceId(id)).toBe(id);
  });

  it("strips disallowed characters", () => {
    expect(sanitizeAiTraceId("sess ion/123$%^&={}")).toBe("session123");
  });

  it("generates a non-empty allowed-charset id when input is missing or empty", () => {
    for (const input of [undefined, "", "$$$$"]) {
      const result = sanitizeAiTraceId(input);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toMatch(TRACE_ID_PATTERN);
    }
  });
});

describe("createAiGenerationRecorder", () => {
  it("captures a $ai_generation event with trace, model, tokens, and latency in seconds", () => {
    const { calls, capture } = makeCapture();
    const record = createAiGenerationRecorder({ capture, env: {} });

    record({
      traceId: "session-123",
      model: "claude-opus-4-6",
      latencyMs: 2500,
      tokensIn: 100,
      tokensOut: 42,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe(AI_GENERATION_EVENT);
    expect(calls[0].event).toBe("$ai_generation");
    const props = calls[0].options.properties ?? {};
    expect(props.$ai_trace_id).toBe("session-123");
    expect(props.$ai_provider).toBe("anthropic");
    expect(props.$ai_model).toBe("claude-opus-4-6");
    expect(props.$ai_input_tokens).toBe(100);
    expect(props.$ai_output_tokens).toBe(42);
    expect(props.$ai_latency).toBe(2.5);
    expect(props.$ai_is_error).toBe(false);
    expect(props.$ai_error).toBeUndefined();
  });

  it("never sends conversation content properties", () => {
    const { calls, capture } = makeCapture();
    const record = createAiGenerationRecorder({ capture, env: {} });

    record({ traceId: "t1", latencyMs: 10 });

    const props = calls[0].options.properties ?? {};
    expect(props).not.toHaveProperty("$ai_input");
    expect(props).not.toHaveProperty("$ai_output_choices");
  });

  it("categorizes errors by name and never includes raw messages", () => {
    const { calls, capture } = makeCapture();
    const record = createAiGenerationRecorder({ capture, env: {} });

    record({
      traceId: "t1",
      latencyMs: 100,
      error: new RangeError("api key sk-ant-secret leaked in message"),
    });

    const props = calls[0].options.properties ?? {};
    expect(props.$ai_is_error).toBe(true);
    expect(props.$ai_error).toBe("RangeError");
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("sk-ant-secret");
    expect(serialized).not.toContain("leaked in message");
  });

  it("categorizes non-Error throwables without serializing them", () => {
    const { calls, capture } = makeCapture();
    const record = createAiGenerationRecorder({ capture, env: {} });

    record({ traceId: "t1", latencyMs: 100, error: "raw failure string with /home/path" });

    const props = calls[0].options.properties ?? {};
    expect(props.$ai_is_error).toBe(true);
    expect(props.$ai_error).toBe("string");
    expect(JSON.stringify(calls[0])).not.toContain("/home/path");
  });

  it("resolves distinct_id from MATRIX_USER_ID, then MATRIX_HANDLE, then matrix-gateway", () => {
    const cases: Array<{ env: Record<string, string>; expected: string }> = [
      { env: { MATRIX_USER_ID: "user_9", MATRIX_HANDLE: "bob" }, expected: "user_9" },
      { env: { MATRIX_HANDLE: "bob" }, expected: "bob" },
      { env: {}, expected: "matrix-gateway" },
    ];

    for (const { env, expected } of cases) {
      const { calls, capture } = makeCapture();
      const record = createAiGenerationRecorder({ capture, env });
      record({ traceId: "t1", latencyMs: 1 });
      expect(calls[0].options.distinctId).toBe(expected);
    }
  });

  it("omits token counts when usage is unavailable", () => {
    const { calls, capture } = makeCapture();
    const record = createAiGenerationRecorder({ capture, env: {} });

    record({ traceId: "t1", latencyMs: 1 });

    const props = calls[0].options.properties ?? {};
    expect(props.$ai_input_tokens).toBeUndefined();
    expect(props.$ai_output_tokens).toBeUndefined();
  });

  it("swallows synchronous capture failures and warns with the error name only", () => {
    const warn = vi.fn();
    const record = createAiGenerationRecorder({
      capture: () => {
        throw new TypeError("posthog exploded with /secret/path");
      },
      env: {},
      logger: { warn },
    });

    expect(() => record({ traceId: "t1", latencyMs: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("TypeError");
    expect(message).not.toContain("/secret/path");
  });

  it("handles rejected capture promises without unhandled rejections", async () => {
    const warn = vi.fn();
    const record = createAiGenerationRecorder({
      capture: () => Promise.reject(new Error("network down")),
      env: {},
      logger: { warn },
    });

    record({ traceId: "t1", latencyMs: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0] as string).not.toContain("network down");
  });
});

describe("dispatcher $ai_generation wiring", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "dispatch-ai-")));
    mkdirSync(join(homePath, "system", "logs"), { recursive: true });
  });

  function usageSpawn(): SpawnFn {
    return async function* (_message, _config) {
      yield { type: "init", sessionId: "kernel-session-1" } as KernelEvent;
      yield { type: "text", text: "hi" } as KernelEvent;
      yield {
        type: "result",
        data: {
          sessionId: "kernel-session-1",
          cost: 0.01,
          turns: 1,
          tokensIn: 120,
          tokensOut: 36,
        },
      } as KernelEvent;
    };
  }

  function failingSpawn(): SpawnFn {
    return async function* (_message, _config) {
      yield { type: "init", sessionId: "kernel-session-err" } as KernelEvent;
      throw new Error("kernel crash with conversation content");
    };
  }

  it("records one generation per completed dispatch with session id as trace id", async () => {
    const onAiGeneration = vi.fn();
    const dispatcher = createDispatcher({
      homePath,
      model: "claude-opus-4-6",
      spawnFn: usageSpawn(),
      maxConcurrency: 1,
      onAiGeneration,
    });

    await dispatcher.dispatch("hello", undefined, () => {});

    expect(onAiGeneration).toHaveBeenCalledTimes(1);
    const input = onAiGeneration.mock.calls[0][0];
    expect(input.traceId).toBe("kernel-session-1");
    expect(input.model).toBe("claude-opus-4-6");
    expect(input.tokensIn).toBe(120);
    expect(input.tokensOut).toBe(36);
    expect(input.latencyMs).toBeGreaterThanOrEqual(0);
    expect(input.error).toBeUndefined();
  });

  it("records an errored generation when the kernel run fails", async () => {
    const onAiGeneration = vi.fn();
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: failingSpawn(),
      maxConcurrency: 1,
      onAiGeneration,
    });

    await dispatcher.dispatch("fail", undefined, () => {}).catch(() => {});

    expect(onAiGeneration).toHaveBeenCalledTimes(1);
    const input = onAiGeneration.mock.calls[0][0];
    expect(input.traceId).toBe("kernel-session-err");
    expect(input.error).toBeInstanceOf(Error);
  });

  it("never passes message content to the generation hook", async () => {
    const onAiGeneration = vi.fn();
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: usageSpawn(),
      maxConcurrency: 1,
      onAiGeneration,
    });

    await dispatcher.dispatch("super secret user prompt", undefined, () => {});

    const serialized = JSON.stringify(onAiGeneration.mock.calls);
    expect(serialized).not.toContain("super secret user prompt");
  });

  it("a throwing generation hook does not break dispatch", async () => {
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: usageSpawn(),
      maxConcurrency: 1,
      onAiGeneration: () => {
        throw new Error("hook exploded");
      },
    });

    const events: KernelEvent[] = [];
    await expect(
      dispatcher.dispatch("hello", undefined, (e) => events.push(e)),
    ).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "result")).toBe(true);
  });

  it("records generations for batch dispatch entries", async () => {
    const onAiGeneration = vi.fn();
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: usageSpawn(),
      maxConcurrency: 1,
      onAiGeneration,
    });

    await dispatcher.dispatchBatch([
      { taskId: "t1", message: "one", onEvent: () => {} },
      { taskId: "t2", message: "two", onEvent: () => {} },
    ]);

    expect(onAiGeneration).toHaveBeenCalledTimes(2);
    for (const call of onAiGeneration.mock.calls) {
      expect(call[0].traceId).toBe("kernel-session-1");
      expect(call[0].tokensIn).toBe(120);
    }
  });
});
