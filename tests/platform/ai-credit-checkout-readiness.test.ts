import { describe, expect, it, vi } from "vitest";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";

describe("AI credit checkout preflight", () => {
  it("passes the remaining request deadline to a paid probe and cancels it when checkout times out", async () => {
    const current = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const funding = {
      policy: { enabled: true, allowedModelIds: ["anthropic/claude-sonnet-5"],
        globalRevision: 1, runtimeRevision: 1, checkedAt: current, staleAfter: future },
      funding: { remainingBudgetMicrousd: 1, asOf: current },
    };
    let probeSignal: AbortSignal | undefined;
    const probe = vi.fn((_model: string, call?: { signal?: AbortSignal; deadlineAtMs?: number }) => {
      probeSignal = call?.signal;
      return new Promise<never>(() => undefined);
    });
    const started = Date.now();
    const healthy = await isAiCreditCheckoutRouteHealthy({
      repository: { getCheckoutFundingSummary: async () => funding } as never,
      identity: { ownerId: "owner", machineId: "machine", runtimeSlot: "primary" },
      modelProbes: { probe }, deadlineMs: 25,
    });
    expect(healthy).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[1]?.deadlineAtMs).toBeGreaterThanOrEqual(started + 25);
    expect(probe.mock.calls[0]?.[1]?.deadlineAtMs).toBeLessThan(started + 100);
    expect(probeSignal?.aborted).toBe(true);
  });

  it("fails closed within the overall deadline when the funding read stalls", async () => {
    const probe = vi.fn();
    let releaseRead!: (error: Error) => void;
    const started = Date.now();
    try {
      const healthy = await isAiCreditCheckoutRouteHealthy({
        repository: { getCheckoutFundingSummary: () => new Promise<never>((_, reject) => { releaseRead = reject; }) },
        identity: { ownerId: "owner", machineId: "machine", runtimeSlot: "primary" },
        modelProbes: { probe },
        deadlineMs: 25,
      });
      expect(healthy).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      releaseRead(new Error("test read released"));
      await Promise.resolve();
    }
  }, 1_000);

  it("limits pending funding reads after repeated checkout timeouts", async () => {
    const releases: Array<(error: Error) => void> = [];
    const repository = { getCheckoutFundingSummary: vi.fn(() => new Promise<never>((_, reject) => {
      releases.push(reject);
    })) };
    const input = {
      repository,
      identity: { ownerId: "owner", machineId: "machine", runtimeSlot: "primary" },
      modelProbes: { probe: vi.fn() },
      deadlineMs: 10,
    };
    try {
      expect(await Promise.all(Array.from({ length: 4 }, () => isAiCreditCheckoutRouteHealthy(input))))
        .toEqual([false, false, false, false]);
      expect(await isAiCreditCheckoutRouteHealthy(input)).toBe(false);
      expect(repository.getCheckoutFundingSummary).toHaveBeenCalledTimes(4);
    } finally {
      for (const release of releases) release(new Error("test read released"));
      await Promise.resolve();
    }
  });
});
