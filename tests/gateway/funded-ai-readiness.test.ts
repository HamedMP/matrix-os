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
  it("shares only in-flight observations and checks revoked policy again after settlement", async () => {
    const { reader, state, fetchFn, getFundingSummary } = setup();
    const summary = Promise.withResolvers<typeof state>();
    getFundingSummary.mockImplementationOnce(() => summary.promise);
    const first = reader.read();
    const second = reader.read();
    try {
      expect(getFundingSummary).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      summary.resolve(structuredClone(state));
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.readiness.state)).toEqual(["ready", "ready"]);
      results[0]!.allowedModelIds.length = 0;
      expect(results[1]!.allowedModelIds).toEqual(["claude-sonnet-5"]);
    }
    state.policy.enabled = false;
    state.policy.allowedModelIds = [];
    expect(await reader.read()).toMatchObject({ readiness: { state: "unavailable" }, allowedModelIds: [] });
    expect(getFundingSummary).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("releases failed shared observations so the next read can recover", async () => {
    const { reader, state, fetchFn, getFundingSummary } = setup();
    const summary = Promise.withResolvers<typeof state>();
    getFundingSummary.mockImplementationOnce(() => summary.promise);
    const first = reader.read();
    const second = reader.read();
    summary.reject(new Error("private failure"));
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.readiness.state)).toEqual(["unavailable", "unavailable"]);
    expect((await reader.read()).readiness.state).toBe("ready");
    expect(getFundingSummary).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborts unfinished relay work when the funding summary rejects first", async () => {
    const health = Promise.withResolvers<Response>();
    const getFundingSummary = vi.fn(async () => { throw new Error("Funding unavailable"); });
    let healthSignal: AbortSignal | undefined;
    const reader = createFundedAiReadinessReader({
      relayBaseUrl: "https://relay.example.test", summary: { getFundingSummary }, now: () => now,
      fetchFn: (async (_url, init) => {
        healthSignal = init?.signal ?? undefined;
        return health.promise;
      }) as typeof fetch,
    });
    try {
      expect((await reader.read()).readiness.state).toBe("unavailable");
      expect(healthSignal?.aborted).toBe(true);
    } finally {
      health.resolve(new Response(null, { status: 200 }));
    }
  });

  it("clears a shared observation at the deadline even if a dependency ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const { reader, state, getFundingSummary } = setup();
      const summary = Promise.withResolvers<typeof state>();
      getFundingSummary.mockImplementationOnce(() => summary.promise);
      const first = reader.read();
      const second = reader.read();
      let completed = 0;
      void first.then(() => { completed += 1; });
      void second.then(() => { completed += 1; });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(completed).toBe(2);
      expect((await first).readiness.state).toBe("unavailable");
      expect((await reader.read()).readiness.state).toBe("ready");
      expect(getFundingSummary).toHaveBeenCalledTimes(2);
      // A late completion must not repopulate readiness after the timeout.
      summary.resolve(state);
      state.policy.enabled = false;
      state.policy.allowedModelIds = [];
      expect((await reader.read()).readiness.state).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

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
