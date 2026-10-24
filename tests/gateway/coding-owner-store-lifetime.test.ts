import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createTurnHarness, ownerPrincipal, postTurn, turnBody } from "./coding-agent-turn-harness.js";

function fakeTime() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
    return controller.signal;
  });
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps a background initial owner run alive beyond the old shared ten-minute deadline", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "coding-owner-initial-"));
  fakeTime();
  let signal: AbortSignal | undefined;
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const threads = createCodingAgentThreadStore({ homePath, providers: [{ providerId: "pi", initialRunExecution: "background",
    async startThread(input) {
      signal = input.signal; await gate;
      return { events: [{ type: "thread.completed", eventId: "evt_long_initial", threadId: input.thread.id,
        occurredAt: new Date().toISOString(), outcome: "completed" }] };
    } }], relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined } });
  try {
    const created = await threads.createThread(ownerPrincipal, { providerId: "pi", prompt: "Keep working", projectId: "repo", clientRequestId: "req_long_initial" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(signal!.aborted).toBe(false);
    complete();
    await vi.waitFor(async () => expect((await threads.getThread(ownerPrincipal, created.snapshot.thread.id)).thread.status).toBe("completed"));
  } finally { complete(); await threads.shutdownTurns(); await rm(homePath, { recursive: true, force: true }); }
});

it("keeps a resumed owner turn alive beyond the old dispatcher ten-minute deadline", async () => {
  fakeTime();
  let signal: AbortSignal | undefined;
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const h = await createTurnHarness({ provider: { providerId: "pi", startThread: input => ({
    events: [{ type: "thread.completed", eventId: input.nextEventId(), threadId: input.thread.id, occurredAt: input.now().toISOString(), outcome: "completed" }],
    resumeState: { conversationId: "owner_same_session" },
  }), async resumeTurn(input) { signal = input.signal; await gate; return { events: [], outcome: "completed", resumeState: input.resumeState }; } } });
  try {
    const path = `/api/coding-agents/threads/${h.threadId}/turns`;
    expect((await h.app.request(postTurn(path, turnBody))).status).toBe(202);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(signal!.aborted).toBe(false);
    complete();
    await vi.waitFor(async () => expect((await h.threads.getThread(ownerPrincipal, h.threadId)).thread.status).toBe("completed"));
  } finally { complete(); await h.cleanup(); }
});
