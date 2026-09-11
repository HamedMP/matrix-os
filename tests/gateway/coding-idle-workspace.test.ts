import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentThreadStore, type CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/thread-store.js";

const owner = { userId: "owner", source: "jwt" as const };
const timestamp = "2026-09-08T00:00:00.000Z";
describe("managed idle Chat ownership", () => {
  it("holds new turn admission behind the idle boundary and retains native history across reload", async () => {
    const homePath = await mkdtemp("/tmp/chat-idle-race-");
    const provider: CodingAgentProviderAdapter = { providerId: "codex", startThread: ({ thread, nextEventId }) => ({
      events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id, occurredAt: timestamp, status: "completed" }],
      resumeState: { conversationId: `sess_${thread.id.slice(7)}`, providerThreadId: "native_history" },
    }), resumeTurn: async ({ resumeState }) => ({ events: [], resumeState, outcome: "delivered" }) };
    const options = { homePath, providers: [provider], now: () => new Date(timestamp) };
    const store = createCodingAgentThreadStore(options);
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      const { snapshot } = await store.createThread(owner, { providerId: "codex", prompt: "Task", mode: "default", approvalPolicy: "never", sandboxMode: "read_only", clientRequestId: "req_create" });
      const sessionId = `sess_${snapshot.thread.id.slice(7)}`;
      const reloaded = createCodingAgentThreadStore(options);
      await expect(reloaded.withIdleWorkspace(sessionId, Date.parse(timestamp) + 1, async (identity) => {
        expect(identity.providerThreadId).toBe("native_history"); return true;
      })).resolves.toBe(true);
      await reloaded.shutdownTurns();
      const idle = store.withIdleWorkspace(sessionId, Date.parse(timestamp) + 1, async () => {
        entered.resolve(); await barrier.promise; return true;
      });
      await entered.promise;
      let accepted = false;
      const next = store.acceptTurn(owner, snapshot.thread.id, { message: "Continue", clientRequestId: "req_next" }).then((result) => { accepted = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(accepted).toBe(false);
      barrier.resolve();
      await expect(idle).resolves.toBe(true);
      await expect(next).resolves.toMatchObject({ status: "accepted" });
      await expect(store.withIdleWorkspace(sessionId, Date.parse(timestamp) + 1, async () => true)).resolves.toBe(false);
    } finally { barrier.resolve(); await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });

  it.each(["completed", "running", "waiting_for_approval", "waiting_for_input", "missing-native-id"])("admits only proven recoverable idle work (%s)", async (mode) => {
    const homePath = await mkdtemp("/tmp/chat-idle-state-");
    const provider: CodingAgentProviderAdapter = { providerId: "codex", startThread: ({ thread, nextEventId }) => ({
      events: [{ type: "thread.status", eventId: nextEventId(), threadId: thread.id, occurredAt: timestamp,
        status: mode === "missing-native-id" ? "completed" : mode } as never],
      resumeState: { conversationId: `sess_${thread.id.slice(7)}`, ...(mode === "missing-native-id" ? {} : { providerThreadId: "native_history" }) },
    }) };
    const store = createCodingAgentThreadStore({ homePath, providers: [provider], now: () => new Date(timestamp) });
    try {
      const { snapshot } = await store.createThread(owner, { providerId: "codex", prompt: "Task", mode: "default", approvalPolicy: "never", sandboxMode: "read_only", clientRequestId: "req_test" });
      const sessionId = `sess_${snapshot.thread.id.slice(7)}`;
      const action = vi.fn(async () => true);
      const cutoff = Date.parse(timestamp) + 1;
      expect(await store.withIdleWorkspace(sessionId, cutoff, action)).toBe(mode === "completed");
      expect(action.mock.calls.length).toBe(mode === "completed" ? 1 : 0);
      expect(await store.withIdleWorkspace("sess_unowned", cutoff, action)).toBe(false);
      expect(await store.withIdleWorkspace(sessionId, Date.parse(timestamp) - 1, action)).toBe(false);
    } finally { await store.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
  });
});
