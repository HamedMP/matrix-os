import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatMessage, CanonicalChatRun } from "@matrix-os/contracts";
import {
  SharedChatExecutionCoordinator,
  SharedChatRunPreparationError,
} from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import type { CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import type { ClaimedQueuedTurn } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "user_owner" };
const scopeId = "11111111-1111-4111-8111-111111111111";
const chatId = "chat_shared";
const now = "2026-09-11T00:00:00.000Z";

function claimed(overrides: Partial<ClaimedQueuedTurn> = {}): ClaimedQueuedTurn {
  return {
    queuedTurn: { id: "queued_1" },
    message: { id: "msg_1", parts: [{ type: "text", text: "Help" }] } as CanonicalChatMessage,
    turn: { id: "turn_1" },
    run: {
      id: "run_1",
      chatId,
      driverKind: "claude_code",
      executionRoot: undefined,
    } as unknown as CanonicalChatRun,
    queueDepth: 0,
    sharedExecution: {
      scopeId,
      requestingActorId: "user_editor",
      authEpoch: 2,
      authorityGeneration: 3,
      executionGeneration: 4,
      executionEligibility: {},
    },
    ...overrides,
  } as ClaimedQueuedTurn;
}

function adapter(): CanonicalChatProviderAdapter {
  return {
    driverKind: "claude_code",
    stateSchemaVersion: 1,
    parseState: (value) => value,
    serializeState: (value) => value,
    start: async function* () {
      yield { type: "run.completed", outcome: "completed" } as const;
    },
  };
}

describe("SharedChatExecutionCoordinator", () => {
  it("claims and prepares only the requested scope before starting dispatch", async () => {
    const repository = {
      claimNextQueuedTurn: vi.fn()
        .mockResolvedValueOnce(claimed())
        .mockResolvedValueOnce(null),
      finishRun: vi.fn(),
      getAdapterState: vi.fn(),
    };
    const startDispatch = vi.fn();
    const notify = vi.fn(async () => undefined);
    const coordinator = new SharedChatExecutionCoordinator({
      repository,
      isClosing: () => false,
      atCapacity: () => false,
      hasActiveRun: () => false,
      getActiveRun: () => undefined,
      startDispatch,
      onSharedEvent: notify,
      now: () => new Date(now),
    });

    await coordinator.dispatchNextQueued(owner, chatId, scopeId, async (context) => {
      expect(context).toMatchObject({ scopeId, requestingActorId: "user_editor" });
      return adapter();
    });

    expect(repository.claimNextQueuedTurn).toHaveBeenCalledWith(owner, expect.objectContaining({
      chatId,
      collaborationScopeId: scopeId,
      claimedAt: now,
    }));
    expect(startDispatch).toHaveBeenCalledWith(expect.objectContaining({ owner, scopeId }));
  });

  it("records an explicit unavailable state when runtime preparation is fenced", async () => {
    const repository = {
      claimNextQueuedTurn: vi.fn().mockResolvedValueOnce(claimed()).mockResolvedValueOnce(null),
      finishRun: vi.fn(async () => undefined),
      getAdapterState: vi.fn(),
    };
    const notify = vi.fn(async () => undefined);
    const coordinator = new SharedChatExecutionCoordinator({
      repository,
      isClosing: () => false,
      atCapacity: () => false,
      hasActiveRun: () => false,
      getActiveRun: () => undefined,
      startDispatch: vi.fn(),
      onSharedEvent: notify,
      now: () => new Date(now),
    });

    await coordinator.dispatchNextQueued(owner, chatId, scopeId, () => {
      throw new SharedChatRunPreparationError("unavailable");
    });

    expect(repository.finishRun).toHaveBeenCalledWith(owner, expect.objectContaining({
      chatId,
      runId: "run_1",
      outcome: "failed",
      sharedRequestState: "unavailable",
    }));
    expect(notify).toHaveBeenCalledWith(scopeId);
  });

  it("cancels only the active run bound to the same scope and session", async () => {
    const activeAdapter = adapter();
    activeAdapter.cancel = vi.fn(async () => undefined);
    const controller = new AbortController();
    const repository = {
      claimNextQueuedTurn: vi.fn(),
      finishRun: vi.fn(async () => undefined),
      getAdapterState: vi.fn(async () => undefined),
    };
    const coordinator = new SharedChatExecutionCoordinator({
      repository,
      isClosing: () => false,
      atCapacity: () => false,
      hasActiveRun: () => true,
      getActiveRun: () => ({
        owner,
        chatId,
        runId: "run_1",
        sharedScopeId: scopeId,
        instanceId: "claude_shared",
        adapter: activeAdapter,
        controller,
      }),
      startDispatch: vi.fn(),
      now: () => new Date(now),
    });

    await coordinator.cancel(owner, scopeId, chatId, "run_1");

    expect(controller.signal.aborted).toBe(true);
    expect(activeAdapter.cancel).toHaveBeenCalledOnce();
    expect(repository.finishRun).toHaveBeenCalledWith(owner, expect.objectContaining({
      chatId,
      runId: "run_1",
      outcome: "aborted",
    }));
  });
});
