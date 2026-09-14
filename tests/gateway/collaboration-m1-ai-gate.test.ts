import { describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrationError, CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { CollaborationChatScopeError } from "../../packages/gateway/src/collaboration/chat-scope.js";

const owner = { type: "personal" as const, ownerId: "user_owner" };
const principal = { userId: "user_owner", source: "verified-session" as const };
const chatId = "chat_shared_gate";

function disabledGuard() {
  return {
    assertPersonalExecutionAllowed: vi.fn(async () => {
      throw new CollaborationChatScopeError(
        "shared_execution_disabled",
        "AI is unavailable for shared discussion",
      );
    }),
  };
}

describe("M1 shared Chat AI gate", () => {
  it("blocks every canonical owner start, queue, control, retry, and approval path", async () => {
    const guard = disabledGuard();
    const underlying = vi.fn(async () => {
      throw new Error("must not reach execution");
    });
    const repository = new Proxy({}, { get: () => underlying });
    const orchestrator = new Proxy({}, { get: () => underlying });
    const service = createCanonicalChatService(repository as never, {
      orchestrator: orchestrator as never,
      collaborationGuard: guard,
    });
    const attempts = [
      () => service.admitTurn(principal, owner, chatId, {} as never),
      () => service.enqueueQueuedTurn(principal, owner, chatId, {} as never),
      () => service.cancelQueuedTurn(owner, chatId, "qturn_one", {} as never),
      () => service.reorderQueuedTurns(owner, chatId, {} as never),
      () => service.updateQueuedTurn(owner, chatId, "qturn_one", {} as never),
      () => service.cancelRun(owner, chatId, "run_one", {} as never),
      () => service.steerRun(owner, chatId, "run_one", {} as never),
      () => service.steerQueuedTurn(owner, chatId, "run_one", "qturn_one", {} as never),
      () => service.submitApproval(owner, chatId, "run_one", "approval_one", {} as never),
      () => service.retryTurn(principal, owner, chatId, "cturn_one", {} as never),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        safeError: { code: "capability_mismatch" },
        status: 409,
      });
    }
    expect(guard.assertPersonalExecutionAllowed).toHaveBeenCalledTimes(attempts.length);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("does not dispatch queued work during reconnect recovery", async () => {
    const guard = disabledGuard();
    const claimNextQueuedTurn = vi.fn();
    const orchestrator = new CanonicalChatOrchestrator({
      repository: {
        listActiveRunContexts: vi.fn(async () => []),
        listQueuedChatIds: vi.fn(async () => [chatId]),
        claimNextQueuedTurn,
      } as never,
      catalog: { getCatalog: vi.fn() } as never,
      adapters: new CanonicalChatProviderRegistry([]),
      collaborationGuard: guard,
    });
    await expect(orchestrator.reconcileActiveRuns(owner)).resolves.toBe(0);
    expect(claimNextQueuedTurn).not.toHaveBeenCalled();
  });

  it("maps direct orchestrator bypass attempts to the same safe disabled result", async () => {
    const orchestrator = new CanonicalChatOrchestrator({
      repository: {} as never,
      catalog: { getCatalog: vi.fn() } as never,
      adapters: new CanonicalChatProviderRegistry([]),
      collaborationGuard: disabledGuard(),
    });
    await expect(orchestrator.admitTurn(principal, owner, chatId, {} as never))
      .rejects.toBeInstanceOf(CanonicalChatOrchestrationError);
    await expect(orchestrator.enqueueQueuedTurn(principal, owner, chatId, {} as never))
      .rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.retryTurn(principal, owner, chatId, "cturn_one", {} as never))
      .rejects.toMatchObject({ status: 409 });
  });
});
