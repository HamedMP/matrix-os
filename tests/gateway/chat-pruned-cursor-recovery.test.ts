import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodingAgentThreadError, createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { recoverCodingRun, recoveryState } from "../../packages/gateway/src/chat/coding-run-recovery.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { recoverOrphanedRun } from "../../packages/gateway/src/chat/orphaned-run-recovery.js";

const principal = { userId: "owner", source: "jwt" as const };

describe("canonical Chat recovery after thread event retention", () => {
  it("recovers the latest exact run after its replay cursor is evicted", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "chat-pruned-cursor-"));
    const provider = { providerId: "codex", abortThread: vi.fn(), startThread: vi.fn(({ thread }: { thread: { id: string } }) => ({
      events: [], resumeState: { conversationId: `sess_${thread.id.slice(7)}`, backgroundRef: { id: "bg_00000000000000000000000000000001" } },
    })) };
    const store = createCodingAgentThreadStore({ homePath, providers: [provider as never] });
    try {
      const created = await store.createThread(principal, { providerId: "codex", prompt: "check CI", clientRequestId: "req_first" });
      const threadId = created.snapshot.thread.id;
      const state = recoveryState(threadId, "run_first", created.snapshot.events.items);
      expect(state.replayAfter).toBeTruthy();
      const occurredAt = "2026-11-02T17:18:34.000Z";
      for (let batch = 0; batch < 6; batch += 1) {
        await store.ingestProviderEvents(principal, threadId, { events: Array.from({ length: 100 }, (_, index) => ({
          type: "assistant.text.completed" as const, threadId, eventId: `evt_noise_${batch}_${index}`,
          occurredAt, messageId: `msg_noise_${batch}_${index}`,
        })) });
      }
      const pending = await recoverCodingRun({ runId: "run_first", state, signal: AbortSignal.timeout(5_000),
        includePending: true, read: cursor => store.getThread(principal, threadId, cursor),
        latestRequestId: () => store.latestTurnRequestId(principal, threadId),
      });
      expect(pending?.outcome).toBe("pending");
      await store.ingestProviderEvents(principal, threadId, { events: [
        { type: "assistant.text.delta", threadId, eventId: "evt_final_text", occurredAt, messageId: "msg_final", delta: "CI passed." },
        { type: "assistant.text.completed", threadId, eventId: "evt_final_end", occurredAt, messageId: "msg_final" },
        { type: "thread.completed", threadId, eventId: "evt_final_done", occurredAt, outcome: "completed" },
      ] });
      await expect(store.getThread(principal, threadId, state.replayAfter)).rejects.toMatchObject({ code: "thread_not_found" });
      const recovered = await recoverCodingRun({ runId: "run_first", state, signal: AbortSignal.timeout(5_000),
        includePending: true, read: cursor => store.getThread(principal, threadId, cursor),
        latestRequestId: () => store.latestTurnRequestId(principal, threadId),
      });
      expect(recovered).toMatchObject({ outcome: "completed", messages: [{ messageId: "msg_final", text: "CI passed." }] });
      const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: store });
      const appendAssistantDelta = vi.fn().mockResolvedValue(undefined);
      const finishRun = vi.fn().mockResolvedValue({ transitioned: true });
      expect(await recoverOrphanedRun({
        owner: { type: "personal", ownerId: principal.userId },
        run: { id: "run_first", chatId: "chat_first", driverKind: "codex", instanceId: "codex_default" } as never,
        repository: { getAdapterState: vi.fn().mockResolvedValue({ schemaVersion: adapter.stateSchemaVersion, state }), appendAssistantDelta, finishRun },
        adapter, messageId: (runId, messageId) => `${runId}:${messageId}`, completedAt: occurredAt,
      })).toBe(true);
      expect(appendAssistantDelta).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delta: "CI passed.", snapshot: true }));
      expect(finishRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: "completed" }));
    } finally { await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("does not attach a later turn to an older Run whose cursor was evicted", async () => {
    const events = { thread: { status: "completed" }, events: { items: [
      { type: "assistant.text.delta", eventId: "evt_other", messageId: "msg_other", delta: "Other answer" },
      { type: "thread.completed", eventId: "evt_other_done", outcome: "completed" },
    ], hasMore: false } };
    const read = vi.fn(async (cursor?: string) => {
      if (cursor) throw new CodingAgentThreadError("thread_not_found", "Thread cursor not found");
      return events as never;
    });
    const recovered = await recoverCodingRun({ runId: "run_first", state: { conversationId: "thread_one", runId: "run_first", replayAfter: "evt_old" },
      signal: new AbortController().signal, read, latestRequestId: async () => "req_other",
    });
    expect(recovered).toBeNull();
  });

  it("drops a message whose beginning was evicted while preserving a later final answer", async () => {
    const recovered = await recoverCodingRun({
      runId: "run_first", state: { conversationId: "thread_one", runId: "run_first", replayAfter: "evt_old" },
      signal: new AbortController().signal, includePending: true,
      read: async (cursor) => {
        if (cursor) throw new CodingAgentThreadError("thread_not_found", "Thread cursor not found");
        return { thread: { status: "completed" }, events: { hasMore: false, items: [
          { type: "assistant.text.delta", eventId: "evt_partial", messageId: "msg_partial", delta: "suffix only" },
          { type: "assistant.text.completed", eventId: "evt_partial_end", messageId: "msg_partial" },
          { type: "assistant.text.delta", eventId: "evt_final", messageId: "msg_final", delta: "Full answer" },
          { type: "assistant.text.completed", eventId: "evt_final_end", messageId: "msg_final" },
          { type: "thread.completed", eventId: "evt_done", outcome: "completed" },
        ] } } as never;
      },
      latestRequestId: async () => "req_first",
    });
    expect(recovered).toMatchObject({ outcome: "completed", messages: [{ messageId: "msg_final", text: "Full answer" }] });
  });
});
