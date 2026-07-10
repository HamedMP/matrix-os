import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodingAgentProviderAdapter } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodingAgentTurnDispatcher } from "../../packages/gateway/src/coding-agents/turn-dispatcher.js";
import {
  createTurnHarness,
  ownerPrincipal,
  postTurn,
  turnBody,
} from "./coding-agent-turn-harness.js";

function completedStart(conversationId: (threadId: string) => string): CodingAgentProviderAdapter["startThread"] {
  return ({ thread, now, nextEventId }) => ({
    events: [{
      type: "thread.completed",
      eventId: nextEventId(),
      threadId: thread.id,
      occurredAt: now().toISOString(),
      outcome: "completed",
    }],
    resumeState: { conversationId: conversationId(thread.id) },
  });
}

describe("coding agent turn dispatch", () => {
  it("GW-017 classifies a stale-sweep timeout as failed rather than user-aborted", async () => {
    let nowMs = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const resumeTurn = vi.fn(() => new Promise(() => undefined));
    const finish = vi.fn(async () => undefined);
    const dispatcher = createCodingAgentTurnDispatcher({
      getProvider: () => ({ providerId: "codex", startThread: () => [], resumeTurn }),
      markRunning: vi.fn(async () => undefined),
      finish,
      nextEventId: () => "evt_sweep_timeout",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      logFailure: vi.fn(),
      timeoutMs: 60_000,
    });
    try {
      const reservation = dispatcher.reserve();
      if (!reservation) throw new Error("reservation unavailable");
      dispatcher.start(reservation, {
        principal: ownerPrincipal,
        thread: {
          id: "thread_sweep_timeout",
          providerId: "codex",
          title: "Coding agent run",
          status: "completed",
          attention: "none",
          projectId: "matrix-os",
          createdAt: "2026-07-10T12:00:00.000Z",
          updatedAt: "2026-07-10T12:00:00.000Z",
        },
        providerResumeState: { conversationId: "conversation_sweep_timeout" },
        turn: { turnId: "turn_sweep_timeout", message: "Continue." },
      });
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledOnce());

      nowMs = 60_001;
      const nextReservation = dispatcher.reserve();
      if (nextReservation) dispatcher.release(nextReservation);

      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        threadId: "thread_sweep_timeout",
        outcome: "failed",
      })));
    } finally {
      await dispatcher.shutdown();
      dateNow.mockRestore();
    }
  });

  it("GW-016 E2E-001 resumes two sequential turns with one provider conversation", async () => {
    const resumeTurn = vi.fn(async (input: {
      thread: { id: string };
      turn: { turnId: string; message: string };
      resumeState: { conversationId: string };
    }) => ({ events: [], outcome: "completed" as const, resumeState: input.resumeState }));
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread: completedStart(() => "provider_conversation_stable"),
      resumeTurn,
    };
    const harness = await createTurnHarness({ provider });
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      expect((await harness.app.request(postTurn(path, {
        message: "Implement the route.",
        clientRequestId: "req_turn_sequential_1",
      }))).status).toBe(202);
      await vi.waitFor(async () => {
        const snapshot = await harness.threads.getThread(ownerPrincipal, harness.threadId);
        expect(snapshot.events.items).toContainEqual(expect.objectContaining({
          type: "turn.status",
          status: "completed",
        }));
      });

      expect((await harness.app.request(postTurn(path, {
        message: "Now add the regression test.",
        clientRequestId: "req_turn_sequential_2",
      }))).status).toBe(202);
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => {
        const snapshot = await harness.threads.getThread(ownerPrincipal, harness.threadId);
        expect(snapshot.events.items.filter((event) =>
          event.type === "turn.status" && event.status === "completed"
        )).toHaveLength(2);
      });

      expect(resumeTurn.mock.calls.map(([input]) => input.thread.id)).toEqual([
        harness.threadId,
        harness.threadId,
      ]);
      expect(resumeTurn.mock.calls.map(([input]) => input.resumeState.conversationId)).toEqual([
        "provider_conversation_stable",
        "provider_conversation_stable",
      ]);
      expect(new Set(resumeTurn.mock.calls.map(([input]) => input.turn.turnId)).size).toBe(2);
      const persisted = await readFile(
        join(harness.homePath, "system", "coding-agents", "threads.json"),
        "utf-8",
      );
      expect(persisted).not.toContain("Implement the route.");
      expect(persisted).not.toContain("Now add the regression test.");
      expect(JSON.stringify(
        await harness.threads.getThread(ownerPrincipal, harness.threadId),
      )).not.toContain("provider_conversation_stable");
    } finally {
      await harness.cleanup();
    }
  });

  it("GW-017 GW-018 releases a timed-out turn with only safe persisted errors", async () => {
    const provider: CodingAgentProviderAdapter = {
      providerId: "codex",
      startThread: completedStart(() => "provider_conversation_timeout"),
      resumeTurn: () => new Promise(() => undefined),
    };
    const harness = await createTurnHarness({ provider, turnDispatchTimeoutMs: 10 });
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_timeout_1",
      }))).status).toBe(202);
      await vi.waitFor(async () => {
        const snapshot = await harness.threads.getThread(ownerPrincipal, harness.threadId);
        expect(snapshot.thread).toMatchObject({ status: "failed", attention: "failed" });
        expect(snapshot.events.items).toContainEqual(expect.objectContaining({
          type: "turn.status",
          status: "failed",
        }));
        expect(JSON.stringify(snapshot)).not.toMatch(/provider_conversation_timeout|token|\/home\//i);
      });
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_timeout_2",
      }))).status).toBe(202);
    } finally {
      await harness.cleanup();
    }
  });

  it("GW-017 aborts an active turn and releases the thread for a later turn", async () => {
    const resumeTurn = vi.fn(() => new Promise(() => undefined));
    const harness = await createTurnHarness({
      provider: {
        providerId: "codex",
        startThread: completedStart(() => "provider_conversation_abort"),
        resumeTurn,
      },
    });
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_abort_1",
      }))).status).toBe(202);
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledTimes(1));
      const aborted = await harness.threads.abortThread(
        ownerPrincipal,
        harness.threadId,
        "req_abort_active_turn_1",
      );
      expect(aborted.thread.status).toBe("aborted");
      expect(aborted.events.items).toContainEqual(expect.objectContaining({
        type: "turn.status",
        status: "aborted",
      }));
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_after_abort_1",
      }))).status).toBe(202);
    } finally {
      await harness.cleanup();
    }
  });

  it("GW-017 reconciles persisted active ownership before accepting a later turn", async () => {
    const resumeTurn = vi.fn(() => new Promise(() => undefined));
    const harness = await createTurnHarness({
      provider: {
        providerId: "codex",
        startThread: completedStart(() => "provider_conversation_recovery"),
        resumeTurn,
      },
    });
    try {
      const path = `/api/coding-agents/threads/${harness.threadId}/turns`;
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_recovery_1",
      }))).status).toBe(202);
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledTimes(1));
      await harness.threads.recoverActiveTurns();
      const recovered = await harness.threads.getThread(ownerPrincipal, harness.threadId);
      expect(recovered.thread).toMatchObject({ status: "failed", attention: "failed" });
      expect(recovered.events.items).toContainEqual(expect.objectContaining({
        type: "turn.status",
        status: "failed",
      }));
      expect((await harness.app.request(postTurn(path, {
        ...turnBody,
        clientRequestId: "req_turn_recovery_2",
      }))).status).toBe(202);
    } finally {
      await harness.cleanup();
    }
  });

  it("GW-018 rejects a full registry before persistence but preserves idempotent retries", async () => {
    const resumeTurn = vi.fn(() => new Promise(() => undefined));
    const harness = await createTurnHarness({
      provider: {
        providerId: "codex",
        startThread: completedStart((threadId) => `provider_conversation_${threadId}`),
        resumeTurn,
      },
      maxTurnDispatches: 1,
    });
    try {
      const second = await harness.threads.createThread(ownerPrincipal, {
        providerId: "codex",
        prompt: "Create the second fixture.",
        projectId: "matrix-os",
        taskId: "task_auth",
        clientRequestId: "req_thread_turn_fixture_2",
      });
      const firstPath = `/api/coding-agents/threads/${harness.threadId}/turns`;
      expect((await harness.app.request(postTurn(firstPath, {
        ...turnBody,
        clientRequestId: "req_turn_capacity_1",
      }))).status).toBe(202);
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledTimes(1));
      expect((await harness.app.request(postTurn(firstPath, {
        ...turnBody,
        clientRequestId: "req_turn_capacity_1",
      }))).status).toBe(200);
      const rejected = await harness.app.request(postTurn(
        `/api/coding-agents/threads/${second.snapshot.thread.id}/turns`,
        { ...turnBody, clientRequestId: "req_turn_capacity_2" },
      ));
      const secondSnapshot = await harness.threads.getThread(ownerPrincipal, second.snapshot.thread.id);
      expect(rejected.status).toBe(409);
      expect(secondSnapshot.events.items.some((event) => event.type === "turn.accepted")).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
