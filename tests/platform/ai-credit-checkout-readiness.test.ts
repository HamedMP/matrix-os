import { describe, expect, it, vi } from "vitest";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";

describe("AI credit checkout preflight", () => {
  it("fails closed within the overall deadline when the funding read stalls", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const started = Date.now();
    const healthy = await isAiCreditCheckoutRouteHealthy({
      repository: { getRuntimeFundingSummary: () => new Promise(() => {}) },
      identity: { ownerId: "owner", machineId: "machine", runtimeSlot: "primary" },
      relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32),
      fetchFn,
      deadlineMs: 25,
    });
    expect(healthy).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchFn).not.toHaveBeenCalled();
  }, 1_000);
});
