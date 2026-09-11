import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const input = {
  owner: { type: "personal" as const, ownerId: "owner_quota" },
  chatId: "chat_quota", turnId: "turn_quota", runId: "run_quota",
  prompt: "hello", parts: [{ type: "text" as const, text: "hello" }],
  selection: { instanceId: "claude_code_default", model: "opus" },
  interactionMode: "default", permissionMode: "supervised",
  signal: new AbortController().signal,
};

function assistantError(text: string) {
  return { type: "assistant", error: "rate_limit", isApiErrorMessage: true,
    message: { role: "assistant", content: [{ type: "text", text }] } };
}

async function replay(lines: unknown[], exitCode = 1, cancel = false) {
  const controller = new AbortController();
  const spawnFn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
      if (cancel) controller.abort();
      child.emit("exit", exitCode, null);
    });
    return child;
  });
  const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn,
    resolveCredentialEnv: async () => ({}) });
  const events: CanonicalProviderRunEvent[] = [];
  for await (const event of adapter.start({ ...input, signal: controller.signal })) events.push(event);
  return { events, spawnFn };
}

afterEach(() => vi.useRealTimers());

describe("Claude usage-limit failure through the adapter", () => {
  it.each([
    { type: "result", is_error: true, result: "Request failed", errors: ["You've hit your weekly limit"] },
    { type: "result", is_error: true, errors: ["Request failed", "You've hit your weekly limit"] },
    { ...assistantError("ignored"), message: { role: "assistant", content: [
      { type: "text", text: "Request failed" }, { type: "text", text: "You've hit your weekly limit" },
    ] } },
    { ...assistantError("ignored"), message: { role: "assistant", content: [
      { type: "text", text: "Too many requests" }, { type: "text", text: "You've hit your weekly limit" },
    ] } },
  ])("recognizes quota evidence independently in a mixed error envelope %#", async (line) => {
    const { events } = await replay([line]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } }]);
  });

  it.each([
    "", " · resets Sep 14, 1pm", " · resets Sep 14, 1pm (PST)",
    " · resets Sep 31, 1pm (UTC)", " · resets Sep 14, 13pm (UTC)",
    " · resets Sep 14, 0am (UTC)", " · resets Sep 14, 1:99pm (UTC)",
    " · resets Sep 9, 1pm (UTC)", " · resets Oct 14, 1pm (UTC)",
    " · resets tomorrow", " · resets Sep 14, 1pm (UTC) token=private /opt/private",
  ])("keeps reset metadata absent or ambiguous (%s) generic and private", async (suffix) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
    const { events } = await replay([assistantError(`You've hit your weekly limit${suffix}`)]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } }]);
  });

  it("validates December to January rollover without guessing an expired year", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-30T08:00:00Z"));
    const { events } = await replay([assistantError("You've hit your weekly limit · resets Jan 2, 12:15am (UTC)")]);
    expect(events.at(-1)).toMatchObject({ error: {
      safeMessage: "Your usage limit has been reached. Try again after 2027-01-02 00:15 UTC.", retryable: false,
    } });
  });

  it.each([
    { ...assistantError("You've hit your weekly limit"), isApiErrorMessage: false },
    { ...assistantError("You've hit your weekly limit"), error: "unknown" },
    { ...assistantError("You've hit your weekly limit"), message: { content: "invalid" } },
    assistantError(`You've hit your weekly limit${"x".repeat(4_001)}`),
  ])("does not trust malformed or non-API assistant error evidence %#", async (line) => {
    const { events } = await replay([line]);
    expect(events.at(-1)).toMatchObject({ outcome: "failed", error: { retryable: true } });
    expect(JSON.stringify(events)).not.toContain("You've hit your weekly limit");
  });

  it("does not classify successful model-authored quota prose as an account failure", async () => {
    const { events } = await replay([{ type: "result", subtype: "success", is_error: false,
      result: "You've hit your weekly limit" }], 0);
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("settles cancellation once without offering quota retry", async () => {
    const { events, spawnFn } = await replay([assistantError("You've hit your weekly limit")], 1, true);
    expect(events).toEqual([{ type: "run.completed", outcome: "aborted" }]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("settles assistant plus result quota evidence once", async () => {
    const { events } = await replay([assistantError("You've hit your weekly limit"),
      { type: "result", is_error: true, result: "You've hit your weekly limit" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "failed", error: { retryable: false } });
  });
  it("does not downgrade quota exhaustion when a later error contains temporary throttling", async () => {
    const { events } = await replay([
      assistantError("You've hit your weekly limit"),
      assistantError("Too many requests. Please try again shortly."),
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: "failed", error: { retryable: false,
      safeMessage: "Your usage limit has been reached. Try again after your allowance resets." } });
  });
  it("retains bounded errors-array evidence from an error result", async () => {
    const { events } = await replay([{ type: "result", is_error: true, subtype: "error_during_execution",
      errors: ["You've hit your weekly limit"] }]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } }]);
  });
  it("keeps temporary native throttling distinct from exhausted allowance", async () => {
    const { events } = await replay([assistantError("Too many requests. Please try again shortly.")]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "service_unavailable", safeMessage: "Requests are temporarily rate limited. Wait a moment and try again.",
      retryable: true, recoveryActions: ["retry"],
    } }]);
  });
  it("normalizes the native reset date using the current execution date and explicit UTC timezone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
    const { events } = await replay([assistantError("You've hit your weekly limit · resets Sep 14, 1pm (UTC)")]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after 2026-09-14 13:00 UTC.",
      retryable: false,
    } }]);
  });
  it("retains explicit result-error quota evidence without an assistant envelope", async () => {
    const { events } = await replay([{ type: "result", is_error: true, subtype: "error_during_execution",
      result: "You've hit your weekly limit" }], 0);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } }]);
  });
  it("reports native assistant-only weekly exhaustion without connection advice or immediate retry", async () => {
    const { events, spawnFn } = await replay([assistantError("You've hit your weekly limit")]);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
      code: "run_failed", safeMessage: "Your usage limit has been reached. Try again after your allowance resets.",
      retryable: false,
    } }]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
