import { describe, expect, it, vi } from "vitest";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";

describe("AI credit checkout preflight", () => {
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
