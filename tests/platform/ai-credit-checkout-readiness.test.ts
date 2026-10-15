import { afterEach, describe, expect, it, vi } from "vitest";
import { isAiCreditCheckoutRouteHealthy } from "../../packages/platform/src/ai-credit-checkout-readiness.js";
import { FUNDED_PROBE_MODELS, type FundedModelProbeResult } from "../../packages/platform/src/ai-funded-model-probes.js";

afterEach(() => { vi.useRealTimers(); });

function catalogFixture() {
  const current = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const funding = {
    policy: { enabled: true, allowedModelIds: [...FUNDED_PROBE_MODELS],
      globalRevision: 1, runtimeRevision: 1, checkedAt: current, staleAfter: future },
    funding: { remainingBudgetMicrousd: 1, asOf: current },
  };
  const ready = { ready: true, checkedAt: current, staleAfter: future };
  const repository = { getCheckoutFundingSummary: vi.fn(async () => funding) };
  const identity = { ownerId: "owner", machineId: "machine", runtimeSlot: "primary" };
  return { funding, ready, repository, identity };
}

describe("AI credit checkout preflight", () => {
  it("starts only the default probe when all ten models are eligible and it is healthy", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const probe = vi.fn(async (_model: string) => f.ready);
    expect(await isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe } })).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toBe("@cf/zai-org/glm-5.3-flash");
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hedges a hung default and cancels it after a fresh alternative succeeds", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const calls: AbortSignal[] = [];
    const probe = vi.fn((_model: string, call?: { signal?: AbortSignal }) => {
      calls.push(call!.signal!);
      return calls.length === 1 ? new Promise<FundedModelProbeResult>(() => undefined) : Promise.resolve(f.ready);
    });
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(calls.every(signal => signal.aborted)).toBe(true);
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledTimes(2);
  });

  it("hedges through eligible Sonnet during a Workers outage without probing the entire catalog", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    let active = 0;
    let maximum = 0;
    const signals: AbortSignal[] = [];
    const probe = vi.fn((model: string, call?: { signal?: AbortSignal }) => {
      maximum = Math.max(maximum, ++active);
      signals.push(call!.signal!);
      call!.signal!.addEventListener("abort", () => { active--; }, { once: true });
      return model === "anthropic/claude-sonnet-5" ? Promise.resolve(f.ready)
        : new Promise<FundedModelProbeResult>(() => undefined);
    });
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(true);
    expect(probe.mock.calls.map(([model]) => model)).toEqual([
      "@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5",
    ]);
    expect(maximum).toBe(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never hedges through Sonnet when the owner policy permits only Workers models", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    f.funding.policy.allowedModelIds = f.funding.policy.allowedModelIds.filter(model => model !== "anthropic/claude-sonnet-5");
    const probe = vi.fn((_model: string) => new Promise<FundedModelProbeResult>(() => undefined));
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(false);
    expect(probe.mock.calls.map(([model]) => model)).toEqual([
      "@cf/zai-org/glm-5.3-flash", "@cf/deepseek-ai/deepseek-v4-flash-0731",
    ]);
  });

  it("advances unavailable candidates with at most two in flight and stops at the first validated success", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    let active = 0;
    let maximum = 0;
    const probe = vi.fn((_model: string, call?: { signal?: AbortSignal }) => new Promise<FundedModelProbeResult>(resolve => {
      maximum = Math.max(maximum, ++active);
      const index = probe.mock.calls.length;
      const timer = setTimeout(() => { active--; resolve({ ...f.ready, ready: index === 4 }); }, 150);
      call?.signal?.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
    }));
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await result).toBe(true);
    expect(maximum).toBe(2);
    expect(probe.mock.calls.length).toBeLessThan(FUNDED_PROBE_MODELS.length);
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledTimes(2);
  });

  it("fits its hedge into the remaining deadline after a slow initial funding read", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    f.repository.getCheckoutFundingSummary.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 950));
      return f.funding;
    });
    const probe = vi.fn((_model: string) => probe.mock.calls.length === 1
      ? new Promise<FundedModelProbeResult>(() => undefined) : Promise.resolve(f.ready));
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(975);
    expect(await result).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed and cancels the pending sibling when fresh policy has been revoked", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const signals: AbortSignal[] = [];
    const probe = vi.fn((_model: string, call?: { signal?: AbortSignal }) => {
      signals.push(call!.signal!);
      return signals.length === 1 ? new Promise<FundedModelProbeResult>(() => undefined) : Promise.resolve(f.ready);
    });
    f.repository.getCheckoutFundingSummary.mockResolvedValueOnce(f.funding)
      .mockResolvedValue({ ...f.funding, policy: { ...f.funding.policy, enabled: false, runtimeRevision: 2 } });
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("rejects expired evidence without a funding reread and cancels a hung sibling at deadline", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const signals: AbortSignal[] = [];
    const probe = vi.fn((_model: string, call?: { signal?: AbortSignal }) => {
      signals.push(call!.signal!);
      return signals.length === 1 ? new Promise<FundedModelProbeResult>(() => undefined)
        : Promise.resolve({ ...f.ready, staleAfter: new Date(Date.now()).toISOString() });
    });
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(false);
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledOnce();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exhausts unavailable candidates lazily and clears both checkout timers", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const probe = vi.fn(async (_model: string) => ({ ...f.ready, ready: false }));
    expect(await isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe } })).toBe(false);
    expect(probe).toHaveBeenCalledTimes(FUNDED_PROBE_MODELS.length);
    expect(f.repository.getCheckoutFundingSummary).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before the hedge on caller disconnect and never launches another candidate", async () => {
    vi.useFakeTimers();
    const f = catalogFixture();
    const controller = new AbortController();
    const probe = vi.fn((_model: string, _call?: { signal?: AbortSignal }) => new Promise<FundedModelProbeResult>(() => undefined));
    const result = isAiCreditCheckoutRouteHealthy({ ...f, modelProbes: { probe }, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

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
