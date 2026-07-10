import { describe, expect, it, vi } from "vitest";
import { createCodingAgentTurnLifecycle } from "../../packages/gateway/src/coding-agents/turn-lifecycle.js";

describe("coding agent turn lifecycle", () => {
  it("enables turns only after recovery with resume-capable providers", async () => {
    const store = {
      recoverActiveTurns: vi.fn(async () => undefined),
      shutdownTurns: vi.fn(async () => undefined),
    };
    const lifecycle = await createCodingAgentTurnLifecycle({
      store,
      providers: [{ resumeTurn: vi.fn() }],
      logFailure: vi.fn(),
    });

    expect(lifecycle.turnsEnabled).toBe(true);
    expect(store.recoverActiveTurns).toHaveBeenCalledOnce();
    await lifecycle.shutdown();
    expect(store.shutdownTurns).toHaveBeenCalledOnce();
  });

  it("fails closed on recovery failure or a provider without resume support", async () => {
    const recoveryFailure = new Error("recovery failed");
    const logFailure = vi.fn();
    const failedRecovery = await createCodingAgentTurnLifecycle({
      store: {
        recoverActiveTurns: vi.fn(async () => { throw recoveryFailure; }),
        shutdownTurns: vi.fn(async () => undefined),
      },
      providers: [{ resumeTurn: vi.fn() }],
      logFailure,
    });
    const missingResume = await createCodingAgentTurnLifecycle({
      store: {
        recoverActiveTurns: vi.fn(async () => undefined),
        shutdownTurns: vi.fn(async () => undefined),
      },
      providers: [{}],
      logFailure,
    });

    expect(failedRecovery.turnsEnabled).toBe(false);
    expect(missingResume.turnsEnabled).toBe(false);
    expect(logFailure).toHaveBeenCalledWith("Failed to reconcile active turns", recoveryFailure);
  });

  it("keeps shutdown best-effort", async () => {
    const shutdownFailure = new Error("shutdown failed");
    const logFailure = vi.fn();
    const lifecycle = await createCodingAgentTurnLifecycle({
      store: {
        recoverActiveTurns: vi.fn(async () => undefined),
        shutdownTurns: vi.fn(async () => { throw shutdownFailure; }),
      },
      providers: [{ resumeTurn: vi.fn() }],
      logFailure,
    });

    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    expect(logFailure).toHaveBeenCalledWith("Turn shutdown failed", shutdownFailure);
  });
});
