import { describe, expect, it, vi } from "vitest";
import { createTurnHarness, ownerPrincipal, otherPrincipal, turnNow } from "./coding-agent-turn-harness.js";

describe("steering a delivered background provider turn", () => {
  it("retains the exact steering target after dispatch settles and fences older turns", async () => {
    const steerTurn = vi.fn(async () => undefined);
    const harness = await createTurnHarness({
      provider: {
        providerId: "codex",
        startThread: ({ thread, nextEventId }) => ({
          events: [{ type: "thread.completed", eventId: nextEventId(), threadId: thread.id,
            occurredAt: turnNow.toISOString(), outcome: "completed" }],
          resumeState: { conversationId: "conversation_delivered" },
        }),
        resumeTurn: ({ resumeState }) => ({ events: [], outcome: "delivered", resumeState }),
        steerTurn,
      },
    });
    try {
      const accept = async (clientRequestId: string) => {
        const turn = await harness.threads.acceptTurn(ownerPrincipal, harness.threadId, {
          message: "Run a long read-only task", clientRequestId,
        });
        await vi.waitFor(async () => {
          const snapshot = await harness.threads.getThread(ownerPrincipal, harness.threadId);
          expect(snapshot.events.items).toContainEqual(expect.objectContaining({
            type: "turn.status", turnId: turn.turnId, status: "completed",
          }));
          expect(snapshot.thread.status).toBe("running");
        });
        return turn;
      };
      const first = await accept("req_delivered_first");
      const steer = (turnId: string) => ({ expectedTurnId: turnId, message: "Continue with checkpoints", clientRequestId: "req_delivered_steer" });
      await expect(harness.threads.steerTurn(ownerPrincipal, harness.threadId, steer(first.turnId))).resolves.toBeUndefined();
      expect(steerTurn).toHaveBeenCalledOnce();
      await expect(harness.threads.steerTurn(otherPrincipal, harness.threadId, steer(first.turnId))).rejects.toThrow("thread_not_found");
      await harness.threads.ingestProviderEvents(ownerPrincipal, harness.threadId, {
        events: [{ type: "thread.completed", eventId: "evt_delivered_done", threadId: harness.threadId,
          occurredAt: turnNow.toISOString(), outcome: "completed" }],
      });
      await expect(harness.threads.steerTurn(ownerPrincipal, harness.threadId, steer(first.turnId))).rejects.toThrow("thread_busy");
      const second = await accept("req_delivered_second");
      await expect(harness.threads.steerTurn(ownerPrincipal, harness.threadId, steer(first.turnId))).rejects.toThrow("thread_busy");
      await expect(harness.threads.steerTurn(ownerPrincipal, harness.threadId, steer(second.turnId))).resolves.toBeUndefined();
      expect(steerTurn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(await harness.threads.getThread(ownerPrincipal, harness.threadId))).not.toContain("deliveredTurnId");
    } finally {
      await harness.cleanup();
    }
  });
});
