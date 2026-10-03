import { describe, expect, it, vi } from "vitest";
import { withAsyncChatInput } from "../../packages/gateway/src/chat/async-input-adapter.js";
import { ChatSteerNotDeliveredError } from "../../packages/gateway/src/chat/steer-delivery-error.js";
import { ChatInputNotDeliveredError } from "../../packages/gateway/src/chat/input-delivery-error.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

function fixture() {
  const controller = new AbortController();
  const input = { owner: { type: "personal", ownerId: "owner_live" }, chatId: "chat_live", runId: "run_live", turnId: "turn_live", prompt: "Ask Alpha or Beta. Wait for my answer then echo it.", parts: [{ type: "text", text: "Ask Alpha or Beta. Wait for my answer then echo it." }], selection: { instanceId: "codex", model: "gpt-6-luna" }, interactionMode: "default", permissionMode: "supervised", signal: controller.signal } as CanonicalProviderRunInput;
  const question = (requestId: string) => ({ type: "input.requested" as const, requestId, title: "Label", questions: [{ questionId: "label", header: "Label", question: "Alpha or Beta?", options: [{ label: "Alpha", description: "Alpha" }, { label: "Beta", description: "Beta" }], allowOther: false, multiSelect: false, secret: false }] });
  const answer = (requestId = "question_live") => ({ owner: input.owner, chatId: input.chatId, runId: input.runId, requestId, clientRequestId: `answer_${requestId}`, structuredAnswers: { label: ["Alpha"] } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  controller.signal.addEventListener("abort", release);
  const resume = vi.fn(async function* () { yield { type: "assistant.delta", delta: "Resumed Alpha" } as const; yield { type: "run.completed", outcome: "completed" } as const; });
  const native: CanonicalChatProviderAdapter = { driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value, deferInput: async () => undefined, resume,
    async *start() { yield { type: "state.updated", state: { session: "same_native" } }; yield question("question_live"); await held; if (!controller.signal.aborted) yield { type: "assistant.delta", delta: "Alpha" }; yield { type: "run.completed", outcome: "completed" }; },
  };
  const collect = (adapter: CanonicalChatProviderAdapter) => { const events: CanonicalProviderRunEvent[] = []; const finished = (async () => { for await (const event of adapter.start(input)) events.push(event); })(); return { events, finished }; };
  return { controller, input, native, question, answer, release, resume, collect };
}

describe("live asynchronous input delivery", () => {
  it("delivers a normal wait-for-answer prompt into the same still-active native turn", async () => {
    const f = fixture();
    const submitDeferredInput = vi.fn(async (input: Parameters<NonNullable<CanonicalChatProviderAdapter["steer"]>>[0]) => { expect(input.runId).toBe(f.input.runId); f.release(); });
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput });
    const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
      expect(await adapter.submitInput!(f.answer())).toBe("queued");
      expect(submitDeferredInput).toHaveBeenCalledOnce();
      expect(submitDeferredInput.mock.calls[0]![0]).toMatchObject({ owner: f.input.owner, chatId: "chat_live", runId: "run_live", turnId: "turn_live", clientRequestId: "answer_question_live", prompt: expect.stringContaining('"label":["Alpha"]') });
      await finished;
      expect(f.resume).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === "input.resolved")).toEqual([{ type: "input.resolved", requestId: "question_live", reason: "answered" }]);
      expect(events).toContainEqual({ type: "assistant.delta", delta: "Alpha" });
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    } finally { f.controller.abort(); await finished; }
  });

  it("holds a fast answer until the deferred native tool has actually been released", async () => {
    const f = fixture(); let releaseTool!: () => void;
    const toolReleased = new Promise<void>(resolve => { releaseTool = resolve; });
    const submitDeferredInput = vi.fn(async () => { f.release(); });
    const adapter = withAsyncChatInput({ ...f.native, deferInput: () => toolReleased, submitDeferredInput });
    const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
      const submitted = adapter.submitInput!(f.answer());
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(submitDeferredInput).not.toHaveBeenCalled();
      releaseTool(); await submitted; await finished;
      expect(submitDeferredInput).toHaveBeenCalledOnce(); expect(f.resume).not.toHaveBeenCalled();
    } finally { releaseTool(); f.controller.abort(); await finished; }
  });

  it("uses a resumed phase when the native phase has already ended", async () => {
    const f = fixture(); const submitDeferredInput = vi.fn();
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput });
    const { events, finished } = f.collect(adapter);
    await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
    f.release(); await vi.waitFor(() => expect(events.some(event => event.type === "assistant.delta")).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    await adapter.submitInput!(f.answer()); await finished;
    expect(submitDeferredInput).not.toHaveBeenCalled(); expect(f.resume).toHaveBeenCalledOnce();
  });

  it("keeps a rejected active control retryable without queuing an unreachable next phase", async () => {
    const f = fixture();
    const submitDeferredInput = vi.fn(async () => { f.release(); }).mockRejectedValueOnce(new ChatInputNotDeliveredError());
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput }); const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
      await expect(adapter.submitInput!(f.answer())).rejects.toBeInstanceOf(ChatInputNotDeliveredError);
      expect(events.some(event => event.type === "input.resolved")).toBe(false);
      await adapter.submitInput!({ ...f.answer(), clientRequestId: "req_retry" }); await finished;
      expect(submitDeferredInput).toHaveBeenCalledTimes(2); expect(f.resume).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === "input.resolved")).toHaveLength(1);
    } finally { f.controller.abort(); await finished; }
  });

  it("falls back only after definite non-delivery and never replays uncertain delivery", async () => {
    for (const definite of [true, false]) {
      const f = fixture();
      const submitDeferredInput = vi.fn(async () => { throw definite ? new ChatSteerNotDeliveredError() : new Error("RPC delivery uncertain"); });
      const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput }); const { events, finished } = f.collect(adapter);
      try {
        await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
        if (definite) await adapter.submitInput!(f.answer());
        else await expect(adapter.submitInput!(f.answer())).rejects.toThrow("RPC delivery uncertain");
        expect(events.some(event => event.type === "input.resolved")).toBe(false);
        f.release(); await finished;
        expect(f.resume).toHaveBeenCalledTimes(definite ? 1 : 0);
        expect(events.filter(event => event.type === "input.resolved")).toHaveLength(definite ? 1 : 0);
      } finally { f.controller.abort(); await finished; }
    }
  });

  it("waits for native acceptance even when completion arrives before the control response", async () => {
    const f = fixture(); let confirm!: () => void;
    const receipt = new Promise<void>(resolve => { confirm = resolve; });
    const submitDeferredInput = vi.fn(async () => { f.release(); await receipt; });
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput }); const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
      const submitted = adapter.submitInput!(f.answer());
      await vi.waitFor(() => expect(events.some(event => event.type === "assistant.delta")).toBe(true));
      expect(events.some(event => event.type === "run.completed" || event.type === "input.resolved")).toBe(false);
      confirm(); await submitted; await finished;
      expect(f.resume).not.toHaveBeenCalled();
      expect(events.slice(-2)).toEqual([{ type: "input.resolved", requestId: "question_live", reason: "answered" }, { type: "run.completed", outcome: "completed" }]);
    } finally { confirm(); f.controller.abort(); await finished; }
  });

  it("delivers concurrent pending answers in arrival order without waiting for native completion", async () => {
    const f = fixture(); let confirmFirst!: () => void;
    const firstReceipt = new Promise<void>(resolve => { confirmFirst = resolve; });
    const submitDeferredInput = vi.fn(async (input: Parameters<NonNullable<CanonicalChatProviderAdapter["steer"]>>[0]) => { expect(input.runId).toBe(f.input.runId); }).mockImplementationOnce(() => firstReceipt);
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput, async *start() {
      yield { type: "state.updated", state: { session: "same_native" } } as const;
      yield f.question("first"); yield f.question("second");
      await new Promise<void>(resolve => f.controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "run.completed", outcome: "completed" } as const;
    } });
    const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.filter(event => event.type === "input.requested")).toHaveLength(2));
      const first = adapter.submitInput!(f.answer("first"));
      await vi.waitFor(() => expect(submitDeferredInput).toHaveBeenCalledOnce());
      const second = adapter.submitInput!(f.answer("second"));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(submitDeferredInput).toHaveBeenCalledOnce();
      confirmFirst(); await first; await second;
      expect(submitDeferredInput).toHaveBeenCalledTimes(2);
      expect(submitDeferredInput.mock.calls.map(([input]) => input.clientRequestId)).toEqual(["answer_first", "answer_second"]);
      expect(f.resume).not.toHaveBeenCalled();
    } finally { confirmFirst(); f.controller.abort(); await finished; }
    expect(events.filter(event => event.type === "input.resolved")).toEqual([
      { type: "input.resolved", requestId: "first", reason: "answered" },
      { type: "input.resolved", requestId: "second", reason: "answered" },
    ]);
  });

  it("keeps several questions independent and resolves only each delivered answer", async () => {
    const f = fixture(); const submitDeferredInput = vi.fn(async () => undefined);
    const adapter = withAsyncChatInput({ ...f.native, submitDeferredInput, async *start() { yield { type: "state.updated", state: { session: "same_native" } } as const; yield f.question("first"); yield f.question("second"); await new Promise<void>(resolve => f.controller.signal.addEventListener("abort", () => resolve(), { once: true })); yield { type: "run.completed", outcome: "completed" } as const; } });
    const { events, finished } = f.collect(adapter);
    try {
      await vi.waitFor(() => expect(events.filter(event => event.type === "input.requested")).toHaveLength(2));
      await expect(adapter.submitInput!({ ...f.answer("first"), owner: { type: "personal", ownerId: "other" } })).rejects.toThrow();
      await adapter.submitInput!(f.answer("first")); await adapter.submitInput!(f.answer("second"));
      expect(submitDeferredInput).toHaveBeenCalledTimes(2); expect(f.resume).not.toHaveBeenCalled();
    } finally { f.controller.abort(); await finished; }
    expect(events.filter(event => event.type === "input.resolved")).toEqual([{ type: "input.resolved", requestId: "first", reason: "answered" }, { type: "input.resolved", requestId: "second", reason: "answered" }]);
  });
});
