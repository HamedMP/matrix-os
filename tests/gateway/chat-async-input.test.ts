import { describe, expect, it, vi } from "vitest";
import { withAsyncChatInput } from "../../packages/gateway/src/chat/async-input-adapter.js";
import { CodingChatStateSchema } from "../../packages/gateway/src/chat/coding-run-recovery.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

const request = { type: "input.requested" as const, requestId: "question_color", title: "Color", questions: [{ questionId: "color", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "Blue" }, { label: "Red", description: "Red" }], allowOther: false, multiSelect: false, secret: false }] };
function fixture() {
  const controller = new AbortController();
  const input = { owner: { type: "personal", ownerId: "owner_1" }, chatId: "chat_1", runId: "run_1", turnId: "turn_1", prompt: "Ask a color, and do independent work.", parts: [{ type: "text", text: "Ask a color, and do independent work." }], selection: { instanceId: "codex", model: "gpt-5.5" }, interactionMode: "default", permissionMode: "supervised", signal: controller.signal } as CanonicalProviderRunInput;
  let release!: () => void;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  const deferInput = vi.fn(async () => { release(); });
  const resume = vi.fn(async function* (value: CanonicalProviderRunInput) {
    yield { type: "assistant.delta", messageId: "answer", delta: value.prompt.includes("Blue") ? "Applied Blue" : "Missing answer" } as const;
    yield { type: "run.completed", outcome: "completed" } as const;
  });
  const native: CanonicalChatProviderAdapter = {
    driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start() {
      yield { type: "state.updated", state: { session: "native_1" } };
      yield request;
      await deferred;
      // Native tool completion is only an acknowledgement, not the user's answer.
      yield { type: "input.resolved", requestId: request.requestId, reason: "answered" };
      yield { type: "assistant.delta", messageId: "independent", delta: "Independent work finished" };
      yield { type: "run.completed", outcome: "completed" };
    },
    deferInput, resume,
  };
  const answer = { owner: input.owner, chatId: input.chatId, runId: input.runId, requestId: request.requestId, clientRequestId: "answer_1", structuredAnswers: { color: ["Blue"] } };
  return { controller, input, native, answer, deferInput, resume };
}

describe("asynchronous canonical questions", () => {
  it("uses continuation identities accepted by the production coding state parser", async () => {
    const f = fixture();
    const native = { ...f.native, parseState: (state: unknown) => CodingChatStateSchema.parse(state), async *start(input: CanonicalProviderRunInput) {
      yield { type: "state.updated", state: { conversationId: "thread_test", runId: input.runId } } as const;
      yield request;
      yield { type: "run.completed", outcome: "completed" } as const;
    }, async *resume(input: CanonicalProviderRunInput) {
      yield { type: "state.updated", state: { conversationId: "thread_test", runId: input.continuationId } } as const;
      yield { type: "run.completed", outcome: "completed" } as const;
    } };
    const adapter = withAsyncChatInput(native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.some(e => e.type === "input.requested")).toBe(true));
    await adapter.submitInput!(f.answer);
    await expect(finished).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  });
  it("includes independent and answer phases in the canonical token usage", async () => {
    const f = fixture();
    const native = { ...f.native, async *start(input: CanonicalProviderRunInput) {
      for await (const event of f.native.start(input)) yield event.type === "run.completed" ? { ...event, tokenUsage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 } } : event;
    }, async *resume() {
      yield { type: "run.completed", outcome: "completed", tokenUsage: { inputTokens: 20, outputTokens: 5 } } as const;
    } };
    const adapter = withAsyncChatInput(native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.some(e => e.type === "assistant.delta")).toBe(true));
    await adapter.submitInput!(f.answer); await finished;
    expect(events.at(-1)).toMatchObject({ tokenUsage: { inputTokens: 30, outputTokens: 8, cachedInputTokens: 2 } });
  });
  it("keeps secret answers on the native input channel instead of persisting them in a resumed prompt", async () => {
    const f = fixture(); let answered!: () => void;
    const answerReceived = new Promise<void>(resolve => { answered = resolve; });
    const submitInput = vi.fn(async () => { answered(); });
    const native = { ...f.native, submitInput, async *start() {
      yield { ...request, questions: request.questions.map(question => ({ ...question, secret: true })) };
      await answerReceived;
      yield { type: "run.completed", outcome: "completed" } as const;
    } };
    const adapter = withAsyncChatInput(native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(events[0]).not.toHaveProperty("asynchronous");
    expect(f.deferInput).not.toHaveBeenCalled();
    await adapter.submitInput!(f.answer); await finished;
    expect(submitInput).toHaveBeenCalledOnce();
    expect(f.resume).not.toHaveBeenCalled();
  });
  it("queues an answer during independent work and waits for the safe native phase boundary", async () => {
    const f = fixture();
    let finishPhase!: () => void;
    const boundary = new Promise<void>(resolve => { finishPhase = resolve; });
    const native = { ...f.native, async *start() {
      yield { type: "state.updated", state: { session: "native_1" } } as const;
      yield request;
      yield { type: "assistant.delta", delta: "Working independently" } as const;
      await boundary;
      yield { type: "run.completed", outcome: "completed" } as const;
    } };
    const adapter = withAsyncChatInput(native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.some(e => e.type === "assistant.delta")).toBe(true));
    await adapter.submitInput!(f.answer);
    expect(f.resume).not.toHaveBeenCalled();
    expect(events.some(e => e.type === "input.resolved")).toBe(false);
    finishPhase(); await finished;
    expect(f.resume).toHaveBeenCalledOnce();
  });
  it("preserves original message parts when adding asynchronous delivery instructions", async () => {
    const f = fixture();
    const start = vi.fn(async function* (_input: CanonicalProviderRunInput) {
      yield { type: "run.completed", outcome: "completed" } as const;
    });
    const adapter = withAsyncChatInput({ ...f.native, start });
    for await (const _event of adapter.start(f.input)) { /* Drain the native phase. */ }
    expect(start.mock.calls[0]![0].parts.slice(0, f.input.parts.length)).toEqual(f.input.parts);
  });
  it("continues independent work before an answer and resumes the same canonical run afterward", async () => {
    const f = fixture(); const adapter = withAsyncChatInput(f.native);
    const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const event of adapter.start(f.input)) events.push(event); })();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ delta: "Independent work finished" })));
    expect(f.deferInput).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "input.requested", asynchronous: true }));
    expect(events.some(e => e.type === "input.resolved" || e.type === "run.completed")).toBe(false);
    expect(await adapter.submitInput!(f.answer)).toBe("queued");
    await finished;
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.resume.mock.calls[0]![0]).toMatchObject({ runId: f.input.runId, turnId: f.input.turnId, resumeState: { session: "native_1" } });
    expect(f.resume.mock.calls[0]![0].continuationId).not.toBe(f.input.runId);
    expect(events).toContainEqual(expect.objectContaining({ delta: "Applied Blue" }));
    expect(events.filter(e => e.type === "input.resolved")).toEqual([{ type: "input.resolved", requestId: request.requestId, reason: "answered" }]);
    expect(events.filter(e => e.type === "run.completed")).toHaveLength(1);
  });

  it("rejects wrong owners, invalid choices and a second answer without repeating native work", async () => {
    const f = fixture(); const adapter = withAsyncChatInput(f.native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.some(e => e.type === "assistant.delta")).toBe(true));
    await expect(adapter.submitInput!({ ...f.answer, owner: { type: "personal", ownerId: "other" } })).rejects.toThrow();
    await expect(adapter.submitInput!({ ...f.answer, structuredAnswers: { color: ["Unknown"] } })).rejects.toThrow();
    await adapter.submitInput!(f.answer);
    await expect(adapter.submitInput!({ ...f.answer, clientRequestId: "answer_2" })).rejects.toThrow();
    await finished;
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it("cancels an unanswered run without inventing an answer or starting another native phase", async () => {
    const f = fixture(); const adapter = withAsyncChatInput(f.native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const e of adapter.start(f.input)) events.push(e); })();
    await vi.waitFor(() => expect(events.some(e => e.type === "assistant.delta")).toBe(true));
    f.controller.abort(); await finished;
    expect(f.resume).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
    await expect(adapter.submitInput!(f.answer)).rejects.toThrow();
  });

  it("expires unanswered questions without choosing a default", async () => {
    const f = fixture(); const adapter = withAsyncChatInput(f.native, { questionTimeoutMs: 30 });
    const events: CanonicalProviderRunEvent[] = [];
    for await (const e of adapter.start(f.input)) events.push(e);
    expect(f.resume).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "input.resolved", requestId: request.requestId, reason: "expired" });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  });
});
