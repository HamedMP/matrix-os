import { describe, expect, it, vi } from "vitest";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";

const now = new Date("2026-10-02T08:00:00.000Z");
function fixture() {
  const state = {
    policy: { enabled: true, globalRevision: 4, runtimeRevision: 2,
      allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 5_100_000,
      checkedAt: now.toISOString(), staleAfter: "2026-10-02T08:01:00.000Z" },
    funding: { topUpEnabled: false, asOf: now.toISOString(), periodStart: "2026-10-01T00:00:00.000Z",
      monthlyBudgetMicrousd: 5_100_000, settledThisMonthMicrousd: 297_893,
      reservedMicrousd: 4_802_107, reservedThisMonthMicrousd: 4_802_107,
      promotionalBalanceMicrousd: 4_802_107, addonBalanceMicrousd: 0,
      creditBalanceMicrousd: 4_802_107, fundingShortfallMicrousd: 0, remainingBalanceMicrousd: 0, remainingBudgetMicrousd: 0 },
  };
  const receipt = { contractVersion: 1 as const, globalRevision: 4, runtimeRevision: 2,
    checkedAt: now.toISOString(), staleAfter: "2026-10-02T08:00:05.000Z", readyModelIds: [] as string[] };
  const getFundingSummary = vi.fn(async () => ({ ...state,
    // This fixture uses only ordinary Chat sources, so its source projection
    // follows the protected aggregate while individual tests vary holds/budget.
    chatAvailability: { contractVersion: 1 as const, asOf: state.funding.asOf,
      eligibleBalanceMicrousd: Math.max(0, state.funding.creditBalanceMicrousd - state.funding.fundingShortfallMicrousd),
      availableBalanceMicrousd: state.funding.remainingBalanceMicrousd },
  }));
  const getRouteReadiness = vi.fn(async () => receipt);
  const reader = createFundedAiReadinessReader({ summary: { getFundingSummary }, routes: { getRouteReadiness }, now: () => now });
  return { reader, state, receipt, getRouteReadiness };
}

describe("funded discovery is separate from executable availability", () => {
  it("keeps policy-authorized discovery and explains current credit/budget holds without a verified route", async () => {
    const f = fixture();
    expect(await f.reader.read()).toMatchObject({ readiness: { state: "unavailable", safeReason: "credit_reserved", action: "retry" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("distinguishes a monthly reservation block when spendable balance is positive", async () => {
    const f = fixture();
    f.state.funding.promotionalBalanceMicrousd = f.state.funding.creditBalanceMicrousd = 9_802_107;
    f.state.funding.remainingBalanceMicrousd = 5_000_000;
    expect(await f.reader.read()).toMatchObject({ readiness: { safeReason: "credit_reserved" }, allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("keeps fresh policy discovery when route observation fails without claiming a working connection", async () => {
    const f = fixture(); f.getRouteReadiness.mockRejectedValue(new Error("private upstream detail"));
    const result = await f.reader.read();
    expect(result).toMatchObject({ readiness: { state: "unavailable", safeReason: "credit_reserved" }, allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("returns the authoritative funding block without waiting for an unrelated stalled route read", async () => {
    vi.useFakeTimers();
    const f = fixture(); const pending = Promise.withResolvers<typeof f.receipt>();
    let completed = false;
    f.getRouteReadiness.mockImplementation(() => pending.promise);
    const result = f.reader.read().then(value => { completed = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(completed).toBe(true);
      expect(await result).toMatchObject({ readiness: { safeReason: "credit_reserved" }, allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
    } finally { pending.resolve(f.receipt); await result; vi.useRealTimers(); }
  });
  it.each(["disabled", "stale_policy", "future_policy", "stale_ledger", "invalid_ledger"])("fails closed on %s", async kind => {
    const f = fixture();
    if (kind === "disabled") { f.state.policy.enabled = false; f.state.policy.allowedModelIds = []; }
    if (kind === "stale_policy") f.state.policy.staleAfter = "2026-10-02T07:59:59.000Z";
    if (kind === "future_policy") f.state.policy.checkedAt = "2026-10-02T08:00:01.000Z";
    if (kind === "stale_ledger") f.state.funding.asOf = "2026-10-02T07:54:00.000Z";
    if (kind === "invalid_ledger") f.state.funding.remainingBalanceMicrousd = 10;
    expect(await f.reader.read()).toMatchObject({ readiness: { state: "unavailable", safeReason: "provider_unavailable" },
      allowedModelIds: [], discoverableModelIds: [] });
  });
  it.each(["mismatched_receipt", "stale_receipt", "unauthorized_receipt"])("keeps only discovery on %s", async kind => {
    const f = fixture();
    if (kind === "mismatched_receipt") f.receipt.runtimeRevision = 3;
    if (kind === "stale_receipt") f.receipt.staleAfter = "2026-10-02T07:59:59.000Z";
    if (kind === "unauthorized_receipt") f.receipt.readyModelIds = ["@cf/zai-org/glm-5.3-flash"];
    expect(await f.reader.read()).toMatchObject({ readiness: { state: "unavailable", safeReason: "credit_reserved" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("identifies true zero credit independently of purchase capability", async () => {
    const f = fixture();
    Object.assign(f.state.funding, { promotionalBalanceMicrousd: 0, creditBalanceMicrousd: 0, reservedMicrousd: 0,
      reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: 4_802_107 });
    expect(await f.reader.read()).toMatchObject({ readiness: { safeReason: "credit_required" }, allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("does not describe settled budget exhaustion as reserved credit", async () => {
    const f = fixture(); Object.assign(f.state.funding, { settledThisMonthMicrousd: 5_100_000,
      reservedMicrousd: 0, reservedThisMonthMicrousd: 0, remainingBalanceMicrousd: 4_802_107 });
    expect(await f.reader.read()).toMatchObject({ readiness: { safeReason: "budget_exceeded", action: "contact_owner" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("does not let a balance hold hide a simultaneously exhausted settled budget", async () => {
    const f = fixture(); Object.assign(f.state.funding, { settledThisMonthMicrousd: 5_100_000,
      reservedThisMonthMicrousd: 0 });
    expect(await f.reader.read()).toMatchObject({ readiness: { safeReason: "budget_exceeded", action: "contact_owner" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("does not let a budget hold hide simultaneously exhausted credit", async () => {
    const f = fixture(); Object.assign(f.state.funding, { fundingShortfallMicrousd: 4_802_107 });
    expect(await f.reader.read()).toMatchObject({ readiness: { safeReason: "credit_required" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"] });
  });
  it("restores only receipt-backed execution after holds clear", async () => {
    const f = fixture(); Object.assign(f.state.funding, { reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
      remainingBalanceMicrousd: 4_802_107, remainingBudgetMicrousd: 4_802_107 });
    f.receipt.readyModelIds = ["anthropic/claude-sonnet-5"];
    expect(await f.reader.read()).toMatchObject({ readiness: { state: "ready", safeReason: null },
      allowedModelIds: ["claude-sonnet-5"], discoverableModelIds: ["claude-sonnet-5"] });
  });
});
