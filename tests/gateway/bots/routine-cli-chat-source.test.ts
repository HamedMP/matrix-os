import { AgentThreadEventSchema, AgentThreadSnapshotSchema } from "@matrix-os/contracts";
import { expect, it, vi } from "vitest";
import { createCanonicalCodingChatProviderAdapter } from "../../../packages/gateway/src/chat/coding-provider-adapter.js";
import * as codexRoutineSource from "../../../packages/gateway/src/chat/codex-routine-source.js";
import { createChatRoutineSourceProducer } from "../../../packages/gateway/src/chat/routine-chat-source.js";
import type { CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../../packages/gateway/src/chat/provider-adapter.js";

const input: CanonicalProviderRunInput = {
  owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_codex_source", turnId: "turn_codex_source", runId: "run_codex_source",
  prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], selection: { instanceId: "codex_default", model: "fixture-model" },
  interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal,
};

it.each([
  { native: { type: "file.changed", eventId: "evt_file", path: "README.md", changeKind: "updated" }, projected: "resource.changed" },
  { native: { type: "assistant.text.delta", eventId: "evt_text", messageId: "msg_final", delta: "Done" }, projected: "assistant.delta" },
])("keeps a routine decision before run completion after $projected", async ({ native, projected }) => {
  const threadId = "thread_native", occurredAt = "2026-08-26T00:00:00.000Z";
  const snapshot = AgentThreadSnapshotSchema.parse({
    thread: { id: threadId, providerId: "codex", title: "Routine Chat", status: "running", attention: "none", createdAt: occurredAt, updatedAt: occurredAt },
    events: { items: [], hasMore: false, limit: 200 },
  });
  type Threads = Parameters<typeof createCanonicalCodingChatProviderAdapter>[0]["threads"];
  let publishNative!: Parameters<Threads["registerEventSink"]>[0];
  const threads: Pick<Threads, "createThread" | "getThread" | "abortThread" | "registerEventSink"> = {
    async createThread() { return { snapshot, existing: false }; },
    async getThread() { return snapshot; },
    async abortThread() { return snapshot; },
    registerEventSink(sink) { publishNative = sink; return { dispose: vi.fn() }; },
  };
  let publishRoutine!: (event: CanonicalProviderRunEvent) => void;
  const sources = vi.spyOn(codexRoutineSource, "createCodexRoutineSources").mockReturnValueOnce({
    open(_input, publish) { publishRoutine = publish; return undefined; },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: threads as Threads });
  sources.mockRestore();

  const stream = adapter.start(input)[Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toMatchObject({ type: "state.updated" });
    const request = {
      type: "approval.requested", approvalId: "appr_routine", title: "Allow routine pause?",
      risk: "medium", allowedDecisions: ["approve", "decline"],
    } satisfies CanonicalProviderRunEvent;
    publishRoutine(request);
    expect((await stream.next()).value).toEqual(request);

    publishNative({ ownerId: input.owner.ownerId, threadId, events: [
      AgentThreadEventSchema.parse({ ...native, threadId, occurredAt }),
      AgentThreadEventSchema.parse({ type: "thread.completed", eventId: "evt_complete", outcome: "completed", threadId, occurredAt }),
    ] });
    expect((await stream.next()).value).toMatchObject({ type: projected });
    const decision = { type: "approval.resolved", approvalId: request.approvalId, decision: "approve" } satisfies CanonicalProviderRunEvent;
    publishRoutine(decision);

    expect((await stream.next()).value).toEqual(decision);
    expect((await stream.next()).value).toEqual({ type: "run.completed", outcome: "completed" });
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return?.();
  }
});

// This exercises the actual producer. Provider is a host-selected port, never a public intent field.
// The original fault labels every admitted provider as Claude before validating any database row.
it("keeps an explicitly selected Codex provider distinct from Claude without increasing its origin ceiling", () => {
  const actual = createChatRoutineSourceProducer({ input, provider: "codex", computerId: "computer_one", signal: input.signal, current: () => true, publish: () => {} });
  expect(actual.producer.source).toMatchObject({ harness: "codex", identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: "native" } });
  expect(actual.producer.readPolicy()).toMatchObject({ live: true, originCeiling: "exact" });
  actual.narrowNativeMode("plan");
  expect(actual.producer.readPolicy()).toMatchObject({ interactionMode: "plan", originCeiling: "read" });
  actual.narrowNativeMode("default");
  expect(actual.producer.readPolicy()).toMatchObject({ interactionMode: "plan", originCeiling: "read" });
});
it("retains the existing Claude default and synchronous source lifetime fence", () => {
  let live = true;
  const actual = createChatRoutineSourceProducer({ input, computerId: "computer_one", signal: input.signal, current: () => live, publish: () => {} });
  expect(actual.producer.source.harness).toBe("claude");
  live = false;
  expect(actual.producer.readPolicy().live).toBe(false);
});
