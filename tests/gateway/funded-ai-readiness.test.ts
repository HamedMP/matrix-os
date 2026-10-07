import { describe, expect, it, vi } from "vitest";
import { createFundedAiReadinessReader } from "../../packages/gateway/src/funded-ai-readiness.js";

const now = new Date("2026-09-05T12:00:00.000Z");
function setup() {
  const state = {
    policy: { enabled: true, globalRevision: 1, runtimeRevision: 1,
      allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 10_000_000,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:01:00.000Z" },
    funding: { topUpEnabled: true, asOf: now.toISOString(), periodStart: "2026-09-01T00:00:00.000Z",
      monthlyBudgetMicrousd: 10_000_000, settledThisMonthMicrousd: 0, reservedMicrousd: 0,
      reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 5_000_000,
      addonBalanceMicrousd: 0, creditBalanceMicrousd: 5_000_000,
      remainingBalanceMicrousd: 5_000_000, remainingBudgetMicrousd: 10_000_000 },
  };
  const getFundingSummary = vi.fn(async () => ({ ...state, chatAvailability: {
    contractVersion: 1 as const, asOf: state.funding.asOf,
    eligibleBalanceMicrousd: state.funding.creditBalanceMicrousd,
    availableBalanceMicrousd: state.funding.remainingBalanceMicrousd,
  } }));
  const getRouteReadiness = vi.fn(async () => ({ contractVersion: 1 as const,
    globalRevision: state.policy.globalRevision, runtimeRevision: state.policy.runtimeRevision,
    checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:00:30.000Z",
    readyModelIds: [...state.policy.allowedModelIds],
  }));
  const reader = createFundedAiReadinessReader({
    summary: { getFundingSummary }, routes: { getRouteReadiness }, now: () => now,
  });
  return { reader, state, getRouteReadiness, getFundingSummary };
}

describe("funded AI readiness", () => {
  it("does not infer Chat credit from speech-only or legacy aggregate funds", async () => {
    const f = setup();
    for (const chatAvailability of [undefined, { contractVersion: 1, asOf: now.toISOString(), eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 }]) {
      const reader = createFundedAiReadinessReader({ summary: { getFundingSummary: async () => ({ ...f.state, ...(chatAvailability ? { chatAvailability } : {}) }) }, routes: { getRouteReadiness: f.getRouteReadiness }, now: () => now });
      const result = await reader.read();
      expect(result.readiness.state).toBe("unavailable");
      expect(result.readiness.safeReason).toBe(chatAvailability ? "credit_required" : "provider_unavailable");
    }
  });

  it("distinguishes eligible credit holds from exhausted credit and exhausted budget", async () => {
    const f = setup();
    f.state.funding.reservedMicrousd = 100;
    f.state.funding.remainingBalanceMicrousd -= 100;
    const projection = { contractVersion: 1 as const, asOf: now.toISOString(), eligibleBalanceMicrousd: 100, availableBalanceMicrousd: 0 };
    const reader = createFundedAiReadinessReader({ summary: { getFundingSummary: async () => ({ ...f.state, chatAvailability: projection }) }, routes: { getRouteReadiness: f.getRouteReadiness }, now: () => now });
    expect((await reader.read()).readiness.safeReason).toBe("credit_reserved");
    projection.eligibleBalanceMicrousd = 0;
    expect((await reader.read()).readiness.safeReason).toBe("credit_required");
    projection.eligibleBalanceMicrousd = 100;
    f.state.funding.settledThisMonthMicrousd = 10_000_000;
    f.state.funding.remainingBudgetMicrousd = 0;
    expect((await reader.read()).readiness.safeReason).toBe("budget_exceeded");
    projection.eligibleBalanceMicrousd = 0;
    expect((await reader.read()).readiness.safeReason).toBe("budget_exceeded");
  });

  it("keeps aggregate shortfall protection separate from the general-source ceiling", async () => {
    const f = setup();
    f.state.funding.reservedMicrousd = 4_999_800;
    f.state.funding.remainingBalanceMicrousd = 0;
    const funding = { ...f.state.funding, fundingShortfallMicrousd: 200 };
    const reader = createFundedAiReadinessReader({ summary: { getFundingSummary: async () => ({ ...f.state, funding, chatAvailability: {
      contractVersion: 1 as const, asOf: now.toISOString(), eligibleBalanceMicrousd: 100, availableBalanceMicrousd: 0,
    } }) }, routes: { getRouteReadiness: f.getRouteReadiness }, now: () => now });
    expect((await reader.read()).readiness.safeReason).toBe("credit_reserved");
  });

  it.each(["missing_time", "future", "stale", "invalid_amount"])("fails closed for %s Chat projection", async kind => {
    const f = setup(); const raw = await f.getFundingSummary();
    if (kind === "missing_time") raw.chatAvailability.asOf = "2026-09-05T11:59:59.000Z";
    if (kind === "future") { raw.funding.asOf = raw.policy.checkedAt = raw.chatAvailability.asOf = "2026-09-05T12:02:00.000Z"; }
    if (kind === "stale") { raw.funding.asOf = raw.policy.checkedAt = raw.chatAvailability.asOf = "2026-09-05T11:54:00.000Z"; }
    if (kind === "invalid_amount") raw.chatAvailability.availableBalanceMicrousd += 1;
    const reader = createFundedAiReadinessReader({ summary: { getFundingSummary: async () => raw }, routes: { getRouteReadiness: f.getRouteReadiness }, now: () => now });
    expect((await reader.read()).readiness.state).toBe("unavailable");
  });

  it("cancels an explicit recipe readiness observer without returning a late ready decision", async () => {
    const f = setup(); const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.getRouteReadiness>>>();
    let observed: AbortSignal | undefined;
    const reader = createFundedAiReadinessReader({ summary: { getFundingSummary: f.getFundingSummary }, now: () => now,
      routes: { getRouteReadiness: async options => { observed = options?.signal; return pending.promise; } } });
    const controller = new AbortController(); const result = reader.read({ signal: controller.signal });
    controller.abort();
    try { expect(observed?.aborted).toBe(true); }
    finally { pending.resolve(await f.getRouteReadiness()); }
    expect((await result).readiness.state).toBe("unavailable");
  });
  it("does not treat relay process liveness as proof that a funded model can run", async () => {
    const { state, getFundingSummary } = setup();
    state.policy.allowedModelIds = ["anthropic/claude-sonnet-5", "@cf/zai-org/glm-5.3-flash"];
    const reader = createFundedAiReadinessReader({ summary: { getFundingSummary }, now: () => now });
    // /health reports only that the relay process is running. Neither model
    // has an authenticated, current readiness receipt in this observation.
    expect(await reader.read()).toMatchObject({
      readiness: { state: "unavailable", safeReason: "provider_unavailable" },
      allowedModelIds: [],
    });
  });

  it("shares only in-flight observations and checks revoked policy again after settlement", async () => {
    const { reader, state, getRouteReadiness, getFundingSummary } = setup();
    const snapshot = await getFundingSummary();
    getFundingSummary.mockClear();
    const summary = Promise.withResolvers<typeof snapshot>();
    getFundingSummary.mockImplementationOnce(() => summary.promise);
    const first = reader.read();
    const second = reader.read();
    try {
      expect(getFundingSummary).toHaveBeenCalledTimes(1);
      expect(getRouteReadiness).toHaveBeenCalledTimes(1);
    } finally {
      summary.resolve(structuredClone(snapshot));
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.readiness.state)).toEqual(["ready", "ready"]);
      results[0]!.allowedModelIds.length = 0;
      expect(results[1]!.allowedModelIds).toEqual(["claude-sonnet-5"]);
    }
    state.policy.enabled = false;
    state.policy.allowedModelIds = [];
    expect(await reader.read()).toMatchObject({ readiness: { state: "unavailable" }, allowedModelIds: [] });
    expect(getFundingSummary).toHaveBeenCalledTimes(2);
    expect(getRouteReadiness).toHaveBeenCalledTimes(2);
  });

  it("releases failed shared observations so the next read can recover", async () => {
    const { reader, state, getRouteReadiness, getFundingSummary } = setup();
    const snapshot = await getFundingSummary();
    getFundingSummary.mockClear();
    const summary = Promise.withResolvers<typeof snapshot>();
    getFundingSummary.mockImplementationOnce(() => summary.promise);
    const first = reader.read();
    const second = reader.read();
    summary.reject(new Error("private failure"));
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.readiness.state)).toEqual(["unavailable", "unavailable"]);
    expect((await reader.read()).readiness.state).toBe("ready");
    expect(getFundingSummary).toHaveBeenCalledTimes(2);
    expect(getRouteReadiness).toHaveBeenCalledTimes(2);
  });

  it("aborts unfinished relay work when the funding summary rejects first", async () => {
    const health = Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof setup>["getRouteReadiness"]>>>();
    const getFundingSummary = vi.fn(async () => { throw new Error("Funding unavailable"); });
    let healthSignal: AbortSignal | undefined;
    const reader = createFundedAiReadinessReader({
      summary: { getFundingSummary }, now: () => now,
      routes: { getRouteReadiness: async (options) => {
        healthSignal = options?.signal;
        return health.promise;
      } },
    });
    try {
      expect((await reader.read()).readiness.state).toBe("unavailable");
      expect(healthSignal?.aborted).toBe(true);
    } finally {
      health.resolve({ contractVersion: 1, globalRevision: 1, runtimeRevision: 1,
        checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:00:30.000Z", readyModelIds: ["anthropic/claude-sonnet-5"] });
    }
  });

  it("allows a cold control plane its full request window but clears a shared observation at the outer deadline", async () => {
    vi.useFakeTimers();
    try {
      const { reader, state, getFundingSummary } = setup();
      const snapshot = await getFundingSummary();
    getFundingSummary.mockClear();
    const summary = Promise.withResolvers<typeof snapshot>();
      getFundingSummary.mockImplementationOnce(() => summary.promise);
      const first = reader.read();
      const second = reader.read();
      let completed = 0;
      void first.then(() => { completed += 1; });
      void second.then(() => { completed += 1; });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(completed).toBe(0);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(completed).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(completed).toBe(0);
      await vi.advanceTimersByTimeAsync(8_000);
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

  it("requires fresh policy, positive credit/budget, and a model readiness receipt", async () => {
    const { reader, getRouteReadiness } = setup();
    expect(await reader.read()).toMatchObject({ readiness: { state: "ready", staleAfter: "2026-09-05T12:00:30.000Z" }, allowedModelIds: ["claude-sonnet-5"] });
    expect(getRouteReadiness).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });
  it.each(["disabled", "expired", "future", "budget", "credit", "stale_ledger"])("fails closed for %s funding", async (reason) => {
    const { reader, state } = setup();
    if (reason === "disabled") { state.policy.enabled = false; state.policy.allowedModelIds = []; }
    if (reason === "expired") state.policy.staleAfter = "2026-09-05T11:59:00.000Z";
    if (reason === "future") { state.policy.checkedAt = "2026-09-05T12:00:30.000Z"; state.funding.asOf = state.policy.checkedAt; }
    if (reason === "budget") { state.funding.settledThisMonthMicrousd = 10_000_000; state.funding.remainingBudgetMicrousd = 0; }
    if (reason === "credit") { state.funding.reservedMicrousd = 5_000_000; state.funding.remainingBalanceMicrousd = 0; }
    if (reason === "stale_ledger") state.funding.asOf = "2026-09-05T11:54:00.000Z";
    expect((await reader.read()).readiness.state).toBe("unavailable");
  });
  it("keeps zero-credit funding separate from route observations and purchase capability", async () => {
    const { reader, state, getRouteReadiness } = setup();
    state.funding.promotionalBalanceMicrousd = 0;
    state.funding.creditBalanceMicrousd = 0;
    state.funding.remainingBalanceMicrousd = 0;
    expect(await reader.read()).toMatchObject({
      readiness: { state: "unavailable", safeReason: "credit_required" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"],
    });
    state.funding.topUpEnabled = false;
    expect((await reader.read()).readiness.safeReason).toBe("credit_required");
    state.funding.topUpEnabled = true;
    getRouteReadiness.mockResolvedValue({ contractVersion: 1, globalRevision: 1, runtimeRevision: 1,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:00:30.000Z", readyModelIds: [] });
    expect(await reader.read()).toMatchObject({
      readiness: { state: "unavailable", safeReason: "credit_required" },
      allowedModelIds: [], discoverableModelIds: ["claude-sonnet-5"],
    });
  });
  it("keeps GLM and Sonnet independent when only one model has a current receipt", async () => {
    const { reader, state, getRouteReadiness } = setup();
    state.policy.allowedModelIds = ["anthropic/claude-sonnet-5", "@cf/zai-org/glm-5.3-flash"];
    getRouteReadiness.mockResolvedValue({ contractVersion: 1, globalRevision: 1, runtimeRevision: 1,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:00:30.000Z",
      readyModelIds: ["@cf/zai-org/glm-5.3-flash"] });
    expect(await reader.read()).toMatchObject({ readiness: { state: "ready" },
      allowedModelIds: ["@cf/zai-org/glm-5.3-flash"] });
  });
  it("rejects a stale or mismatched model receipt despite positive funding", async () => {
    const { reader, getRouteReadiness } = setup();
    getRouteReadiness.mockResolvedValueOnce({ contractVersion: 1, globalRevision: 2, runtimeRevision: 1,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T12:00:30.000Z",
      readyModelIds: ["anthropic/claude-sonnet-5"] });
    expect((await reader.read()).readiness.state).toBe("unavailable");
    getRouteReadiness.mockResolvedValueOnce({ contractVersion: 1, globalRevision: 1, runtimeRevision: 1,
      checkedAt: now.toISOString(), staleAfter: "2026-09-05T11:59:00.000Z",
      readyModelIds: ["anthropic/claude-sonnet-5"] });
    expect((await reader.read()).readiness.state).toBe("unavailable");
  });
  it("does not expose upstream errors or claim readiness when relay or policy calls fail", async () => {
    const { reader, getRouteReadiness, getFundingSummary } = setup();
    getRouteReadiness.mockRejectedValue(new Error("private relay details"));
    expect((await reader.read()).readiness.state).toBe("unavailable");
    getFundingSummary.mockRejectedValue(new Error("private upstream details"));
    expect(JSON.stringify(await reader.read())).not.toContain("private");
  });
});
