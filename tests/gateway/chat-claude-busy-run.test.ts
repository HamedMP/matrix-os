import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";

const input = { owner: { type: "personal" as const, ownerId: "owner_busy" }, chatId: "chat_busy", turnId: "cturn_busy", runId: "run_busy",
  prompt: "Think through this task", parts: [{ type: "text" as const, text: "Think through this task" }],
  selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: "supervised" };

afterEach(() => vi.useRealTimers());

async function start(options: { initialized?: boolean; fundedRunTimeoutMs?: number } = {}) {
  const signal = new AbortController();
  const stdout = new EventEmitter();
  const writes: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(),
    stdin: { write: (frame: string, callback?: (error?: Error | null) => void) => { writes.push(JSON.parse(frame)); callback?.(); return true; } },
    kill: vi.fn((killSignal: NodeJS.Signals) => queueMicrotask(() => child.emit("exit", null, killSignal))),
  });
  const adapter = createClaudeChatProviderAdapter({ homePath: "/safe/home", spawnFn: () => child,
    resolveCredentialLaunch: async () => ({ env: {}, ...(options.fundedRunTimeoutMs ? { fundedRunTimeoutMs: options.fundedRunTimeoutMs } : {}) }),
  });
  const events: CanonicalProviderRunEvent[] = [];
  const result = (async () => { for await (const event of adapter.start({ ...input, signal: signal.signal })) events.push(event); })();
  await vi.advanceTimersByTimeAsync(0);
  const emit = (frame: Record<string, unknown>) => stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  if (options.initialized !== false) emit({ type: "system", subtype: "init", session_id: "busy_session" });
  const complete = async () => { emit({ type: "result", subtype: "success", result: "finished", session_id: "busy_session" }); child.emit("exit", 0, null); await result; };
  const close = async () => { signal.abort(); await result; };
  return { adapter, child, events, writes, result, emit, complete, close };
}

it.each([31 * 60_000, 25 * 60 * 60_000])("keeps a silent initialized owner turn busy for %i ms without progress keepalives", async elapsed => {
  vi.useFakeTimers();
  const run = await start();
  try {
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(run.events.some(event => event.type === "run.completed")).toBe(false);
    expect(run.child.kill).not.toHaveBeenCalled();
    await run.complete();
    expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});

it("still stops a silent long-running owner turn and never accepts its late result", async () => {
  vi.useFakeTimers();
  const run = await start();
  try {
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await run.adapter.cancel({ owner: input.owner, chatId: input.chatId, runId: input.runId });
    await run.result;
    await run.complete();
    expect(run.events.filter(event => event.type === "run.completed")).toEqual([{ type: "run.completed", outcome: "aborted" }]);
    expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});

it("keeps multiple human questions independent of the busy turn lifetime", async () => {
  vi.useFakeTimers();
  const run = await start();
  try {
    const question = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Blue", description: "Ocean" }, { label: "Red", description: "Fire" }] }] };
    for (const requestId of ["first", "second"]) run.emit({ type: "control_request", request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: question } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await run.adapter.submitInput!({ ...input, requestId: "first", clientRequestId: "answer_first", structuredAnswers: { q0: ["Blue"] } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await run.adapter.submitInput!({ ...input, requestId: "second", clientRequestId: "answer_second", structuredAnswers: { q0: ["Red"] } });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(run.child.kill).not.toHaveBeenCalled();
    await run.complete();
    expect(run.events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});

it("bounds initialization separately when no valid provider frame arrives", async () => {
  vi.useFakeTimers();
  const run = await start({ initialized: false });
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    await run.result;
    expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});

it("retains an explicitly injected funded compatibility deadline after initialization", async () => {
  vi.useFakeTimers();
  const run = await start({ fundedRunTimeoutMs: 10 * 60_000 });
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await run.result;
    expect(run.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(run.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await run.close(); }
});
