import { describe, expect, it, vi } from "vitest";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";

const now = new Date("2026-09-05T12:00:00.000Z");
function setup() {
  const state = {
    policy: { enabled: true, globalRevision: 1, runtimeRevision: 1,
      allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 10_000_000,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:01:00.000Z" },
    funding: { asOf: now.toISOString(), periodStart: "2026-09-01T00:00:00.000Z",
      monthlyBudgetMicrousd: 10_000_000, settledThisMonthMicrousd: 0, reservedMicrousd: 0,
      reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 5_000_000,
      addonBalanceMicrousd: 0, creditBalanceMicrousd: 5_000_000,
      remainingBalanceMicrousd: 5_000_000, remainingBudgetMicrousd: 10_000_000 },
  };
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const getFundingSummary = vi.fn(async () => state);
  const reader = createFundedAiReadinessReader({
    relayBaseUrl: "https://relay.example.test", summary: { getFundingSummary },
    fetchFn: fetchFn as typeof fetch, now: () => now,
  });
  return { reader, state, fetchFn, getFundingSummary };
}

describe("funded AI readiness", () => {
  it("requires fresh policy, positive credit/budget, and a bounded relay health check", async () => {
    const { reader, fetchFn } = setup();
    expect(await reader.read()).toMatchObject({ readiness: { state: "ready", staleAfter: "2026-09-05T12:00:30.000Z" }, allowedModelIds: ["claude-sonnet-5"] });
    expect(fetchFn).toHaveBeenCalledWith("https://relay.example.test/health", expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal),
    }));
  });
  it.each(["disabled", "expired", "future", "budget", "credit"])("fails closed for %s funding", async (reason) => {
    const { reader, state } = setup();
    if (reason === "disabled") { state.policy.enabled = false; state.policy.allowedModelIds = []; }
    if (reason === "expired") state.policy.staleAfter = "2026-09-05T11:59:00.000Z";
    if (reason === "future") { state.policy.checkedAt = "2026-09-05T12:00:30.000Z"; state.funding.asOf = state.policy.checkedAt; }
    if (reason === "budget") { state.funding.settledThisMonthMicrousd = 10_000_000; state.funding.remainingBudgetMicrousd = 0; }
    if (reason === "credit") { state.funding.reservedMicrousd = 5_000_000; state.funding.remainingBalanceMicrousd = 0; }
    expect((await reader.read()).readiness.state).toBe("unavailable");
  });
  it("does not expose upstream errors or claim readiness when relay or policy calls fail", async () => {
    const { reader, fetchFn, getFundingSummary } = setup();
    fetchFn.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await reader.read()).readiness.state).toBe("unavailable");
    getFundingSummary.mockRejectedValue(new Error("private upstream details"));
    expect(JSON.stringify(await reader.read())).not.toContain("private");
  });
});
