import { describe, expect, it, vi } from "vitest";
import { AgentThreadSnapshotSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { withAsyncChatInput } from "../../packages/gateway/src/chat/async-input-adapter.js";
import { ChatSteerNotDeliveredError } from "../../packages/gateway/src/chat/steer-delivery-error.js";
import { ChatInputNotDeliveredError } from "../../packages/gateway/src/chat/input-delivery-error.js";
import { CodingAgentTurnError, type CodingAgentThreadStore, type CodingAgentTurnStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

function fixture() {
  const now = "2026-10-03T00:00:00.000Z";
  const owner = { type: "personal" as const, ownerId: "owner_live" };
  const input = { owner, chatId: "chat_live", turnId: "turn_live", runId: "run_live", prompt: "Ask Alpha or Beta. Wait for my answer then echo it.", parts: [{ type: "text", text: "Ask Alpha or Beta. Wait for my answer then echo it." }], selection: { instanceId: "codex", model: "gpt-6-luna" }, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal } as CanonicalProviderRunInput;
  const requested: AgentThreadEvent = { type: "user_input.requested", eventId: "evt_question", threadId: "thread_live", occurredAt: now, request: { requestId: "req_question_live", correlationId: "corr_live", threadId: "thread_live", title: "Label", safeDescription: "Pick a label", questions: [{ questionId: "label", header: "Label", question: "Alpha or Beta?", allowOther: false, secret: false, options: [{ label: "Alpha", description: "Alpha" }, { label: "Beta", description: "Beta" }] }] } };
  const snapshot = AgentThreadSnapshotSchema.parse({ thread: { id: "thread_live", providerId: "codex", title: "Live", status: "running", attention: "none", createdAt: now, updatedAt: now }, events: { items: [requested], hasMore: false, limit: 200 } });
  let sink: Parameters<CodingAgentThreadStore["registerEventSink"]>[0] | undefined;
  const createThread = vi.fn(async () => ({ snapshot, existing: false }));
  const acceptTurn = vi.fn(); const abortThread = vi.fn(async () => snapshot);
  const steerTurn = vi.fn(async () => { sink?.({ ownerId: owner.ownerId, threadId: "thread_live", events: [{ type: "assistant.text.delta", eventId: "evt_reply", threadId: "thread_live", occurredAt: now, messageId: "message_live", delta: "Alpha" }, { type: "thread.completed", eventId: "evt_done", threadId: "thread_live", occurredAt: now, outcome: "completed" }] }); });
  const threads = { createThread, acceptTurn, abortThread, steerTurn, getThread: vi.fn(async () => snapshot), registerEventSink: vi.fn((value) => { sink = value; return { dispose: vi.fn() }; }) } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
  const deferInput = vi.fn(async () => undefined);
  const native = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, nativeInputProvider: { deferInput } });
  return { owner, input, native, steerTurn, createThread, acceptTurn, abortThread, deferInput };
}

describe("canonical Coding deferred answer wiring", () => {
  it("delivers validated answers through exact live native steering without a second admission or cancellation", async () => {
    const f = fixture(); const adapter = withAsyncChatInput(f.native); const events: CanonicalProviderRunEvent[] = [];
    const finished = (async () => { for await (const event of adapter.start(f.input)) events.push(event); })();
    await vi.waitFor(() => expect(events.some(event => event.type === "input.requested")).toBe(true));
    await adapter.submitInput!({ owner: f.owner, chatId: "chat_live", runId: "run_live", requestId: "req_question_live", clientRequestId: "req_answer", structuredAnswers: { label: ["Alpha"] } });
    await finished;
    expect(f.deferInput).toHaveBeenCalledOnce();
    expect(f.steerTurn).toHaveBeenCalledWith({ userId: f.owner.ownerId, source: "configured-container" }, "thread_live", { clientRequestId: "req_answer", message: expect.stringContaining('"label":["Alpha"]') });
    expect(f.createThread).toHaveBeenCalledOnce(); expect(f.acceptTurn).not.toHaveBeenCalled(); expect(f.abortThread).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "input.resolved", requestId: "req_question_live", reason: "answered" });
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.delta", delta: "Alpha" }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  });

  it.each(["CodexControlRejectedError", "CodexControlUnavailableError", "thread_busy"])("classifies %s as definite non-delivery", async reason => {
    const f = fixture(); const stream = f.native.start(f.input)[Symbol.asyncIterator](); await stream.next();
    const error = reason === "thread_busy" ? new CodingAgentTurnError("thread_busy") : Object.assign(new Error("control failed"), { name: reason });
    f.steerTurn.mockRejectedValueOnce(error);
    await expect(f.native.submitDeferredInput!({ owner: f.owner, chatId: "chat_live", runId: "run_live", turnId: "turn_live", clientRequestId: "req_answer", prompt: "Alpha", parts: [{ type: "text", text: "Alpha" }] })).rejects.toBeInstanceOf(reason === "thread_busy" ? ChatSteerNotDeliveredError : ChatInputNotDeliveredError);
    await stream.return!();
  });

  it("preserves uncertain native transport failure without declaring non-delivery", async () => {
    const f = fixture(); const stream = f.native.start(f.input)[Symbol.asyncIterator](); await stream.next();
    const error = Object.assign(new Error("control failed"), { name: "CodexControlTransportError" });
    f.steerTurn.mockRejectedValueOnce(error);
    await expect(f.native.submitDeferredInput!({ owner: f.owner, chatId: "chat_live", runId: "run_live", turnId: "turn_live", clientRequestId: "req_answer", prompt: "Alpha", parts: [{ type: "text", text: "Alpha" }] })).rejects.toBe(error);
    await stream.return!();
  });
});
