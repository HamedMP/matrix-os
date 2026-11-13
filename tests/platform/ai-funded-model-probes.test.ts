import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFundedModelProbeService, loadFundedModelProbeLimits, reserveFundedModelProbe, FUNDED_PROBE_MODELS } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";

const now = new Date("2026-09-25T12:00:00.000Z");
const sonnet = "anthropic/claude-sonnet-5";
const pricedReady = { ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z" };

describe("fleet funded model probe budget", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); });

  it("defaults disabled and never sends an upstream call without both operator limits", async () => {
    expect(loadFundedModelProbeLimits({})).toBeUndefined();
    expect(loadFundedModelProbeLimits({ MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "10" })).toBeUndefined();
    const fetchFn = vi.fn<typeof fetch>();
    const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32), fetchFn, now: () => now });
    expect((await probes.probe(sonnet)).ready).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("atomically limits concurrent reservations across service instances and does not spend day count on minute exhaustion", async () => {
    const reserved = await Promise.all(Array.from({ length: 8 }, () =>
      reserveFundedModelProbe({ db, now, dailyLimit: 3, minuteLimit: 2 })));
    expect(reserved.filter(Boolean)).toHaveLength(2);
    const rows = await sql<{ day_used: number; minute_used: number }>`
      select day_used, minute_used from ai_funded_model_probe_budget
    `.execute(db.executor);
    expect(rows.rows).toEqual([{ day_used: 2, minute_used: 2 }]);
    expect(await reserveFundedModelProbe({ db, now: new Date(now.getTime() - 60_000), dailyLimit: 3, minuteLimit: 2 })).toBe(false);
    const unchanged = await sql<{ day_used: number; minute_used: number }>`
      select day_used, minute_used from ai_funded_model_probe_budget
    `.execute(db.executor);
    expect(unchanged.rows).toEqual([{ day_used: 2, minute_used: 2 }]);
    expect(await reserveFundedModelProbe({ db, now: new Date(now.getTime() + 60_000), dailyLimit: 4, minuteLimit: 3 })).toBe(false);
  });

  it("can admit one bounded cold fanout for every reviewed text model", async () => {
    const reserved = await Promise.all(FUNDED_PROBE_MODELS.map(() =>
      reserveFundedModelProbe({ db, now, dailyLimit: 3000, minuteLimit: 20 })));
    expect(reserved).toHaveLength(11);
    expect(reserved.every(Boolean)).toBe(true);
    const rows = await sql<{ day_used: number; minute_used: number }>`
      select day_used, minute_used from ai_funded_model_probe_budget
    `.execute(db.executor);
    expect(rows.rows).toEqual([{ day_used: 11, minute_used: 11 }]);
  });

  it("coalesces repeated probes and retains the fleet count after service restart", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 1, minuteLimit: 1, fetchFn, now: () => now };
    const first = createFundedModelProbeService(input);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const receiptId = "12345678-1234-4123-8123-123456789abc";
    const observations = await Promise.all(Array.from({ length: 5 }, () => first.probe(sonnet, { receiptId })));
    expect(observations.every((item) => item.ready)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const headers = fetchFn.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-matrix-readiness-probe-id"]).toMatch(/^[a-f0-9-]{36}$/);
    const joined = info.mock.calls.map(c => JSON.parse(String(c[0]))).filter(e => e.event === "funded_readiness_join");
    expect(joined).toHaveLength(5);
    expect(joined.every(e => e.receiptId === receiptId && e.probeId === headers["x-matrix-readiness-probe-id"] && e.modelId === sonnet && e.ready === true)).toBe(true);
    expect((await first.probe(sonnet)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const restarted = createFundedModelProbeService(input);
    expect((await restarted.probe(sonnet)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("admits only one paid call across concurrent Platform service instances", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 1, minuteLimit: 1, fetchFn, now: () => now };
    const first = createFundedModelProbeService(input);
    const second = createFundedModelProbeService(input);
    const results = await Promise.all([first.probe(sonnet), second.probe(sonnet)]);
    expect(results.filter((result) => result.ready)).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled budget database and never starts a delayed paid probe", async () => {
    const neverReady = new Promise<void>(() => undefined);
    const stalledDb = { ready: neverReady } as PlatformDB;
    const fetchFn = vi.fn<typeof fetch>();
    const probes = createFundedModelProbeService({ db: stalledDb, relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32), dailyLimit: 1, minuteLimit: 1,
      budgetDeadlineMs: 20, fetchFn, now: () => now });
    const started = Date.now();
    expect((await probes.probe(sonnet)).ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not start a paid fetch when the last caller expires during budget admission", async () => {
    const admission = Promise.withResolvers<boolean>();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32), dailyLimit: 1, minuteLimit: 1,
      reserveProbe: () => admission.promise, fetchFn, now: () => now });
    const result = await probes.probe(sonnet, { deadlineAtMs: Date.now() + 20 });
    expect(result.ready).toBe(false);
    admission.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps a coalesced paid probe alive for a second caller after the first expires", async () => {
    const admission = Promise.withResolvers<boolean>();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32), dailyLimit: 1, minuteLimit: 1,
      reserveProbe: () => admission.promise, fetchFn, now: () => now });
    const first = probes.probe(sonnet, { deadlineAtMs: Date.now() + 20 });
    const second = probes.probe(sonnet, { deadlineAtMs: Date.now() + 1_000 });
    expect((await first).ready).toBe(false);
    admission.resolve(true);
    expect((await second).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("skips eight expired models before reserving capacity on either replica", async () => {
    const healthy = new Set<string>([sonnet, FUNDED_PROBE_MODELS[0]]);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(pricedReady));
    const readPricingReview = async (modelId: string) => ({
      version: "reviewed-rate",
      validThrough: healthy.has(modelId) ? pricedReady.priceValidThrough : now.toISOString(),
    });
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 20, minuteLimit: 20, fetchFn, now: () => now, readPricingReview };
    const replicas = [createFundedModelProbeService(input), createFundedModelProbeService(input)];
    for (const results of await Promise.all(replicas.map(service => Promise.all(
      FUNDED_PROBE_MODELS.map(async model => (await service.probe(model)).ready),
    )))) {
      expect(results).toEqual(FUNDED_PROBE_MODELS.map(model => healthy.has(model)));
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const budget = await sql<{ day_used: number }>`select day_used from ai_funded_model_probe_budget`.execute(db.executor);
    expect(budget.rows).toEqual([{ day_used: 2 }]);
  });

  it("shares fifteen minutes of health only while the exact price review remains eligible", async () => {
    let clock = now;
    let validThrough: string | null = pricedReady.priceValidThrough;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(pricedReady));
    const readPricingReview = async () => validThrough ? { version: "reviewed-rate", validThrough } : null;
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 20, minuteLimit: 20, fetchFn, now: () => clock, readPricingReview };
    const first = createFundedModelProbeService(input);
    const second = createFundedModelProbeService(input);
    expect((await first.probe(sonnet)).staleAfter).toBe("2026-09-25T12:15:00.000Z");
    clock = new Date(now.getTime() + 14 * 60_000);
    expect((await second.readCached!(sonnet)).ready).toBe(true);
    expect((await second.probe(sonnet)).ready).toBe(true);
    validThrough = null;
    expect((await first.readCached!(sonnet)).ready).toBe(false);
    expect((await second.probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("invalidates only the exact reviewed receipt that predates a real upstream failure", async () => {
    let clock = now;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(pricedReady));
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 20, minuteLimit: 20, fetchFn, now: () => clock,
      readPricingReview: async () => ({ version: "reviewed-rate", validThrough: pricedReady.priceValidThrough }) };
    const first = createFundedModelProbeService(input);
    const second = createFundedModelProbeService(input);
    expect((await first.probe(sonnet)).ready).toBe(true);
    const failedAt = new Date(now.getTime() + 30_000);
    clock = failedAt;
    await second.invalidateAfterUpstreamFailure!(sonnet, "different-rate", failedAt);
    expect((await first.readCached!(sonnet)).ready).toBe(true);
    await second.invalidateAfterUpstreamFailure!(sonnet, "reviewed-rate", failedAt);
    expect((await first.readCached!(sonnet)).ready).toBe(false);
    expect((await second.probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock = new Date(now.getTime() + 90_000);
    expect((await second.probe(sonnet)).ready).toBe(true);
    await first.invalidateAfterUpstreamFailure!(sonnet, "reviewed-rate", failedAt);
    expect((await second.readCached!(sonnet)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shares retry backoff and preserves a normal refresh after expedited retries are exhausted", async () => {
    let clock = now;
    const [firstBad, secondBad, healthy] = FUNDED_PROBE_MODELS;
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const model = new URL(String(request)).searchParams.get("model");
      return model === healthy || clock.getTime() === now.getTime() + 15 * 60_000
        ? Response.json(pricedReady)
        : new Response(null, { status: 503 });
    });
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 12, minuteLimit: FUNDED_PROBE_MODELS.length + 2, fetchFn, now: () => clock,
      readPricingReview: async () => ({ version: "reviewed-rate", validThrough: pricedReady.priceValidThrough }),
      reserveProbe: (request: Parameters<typeof reserveFundedModelProbe>[0]) => reserveFundedModelProbe({ ...request, now: clock }) };
    const first = createFundedModelProbeService(input);
    const second = createFundedModelProbeService(input);
    await Promise.all([first.probe(firstBad), second.probe(secondBad)]);
    clock = new Date(now.getTime() + 10_000);
    await Promise.all([second.probe(firstBad), first.probe(secondBad)]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clock = new Date(now.getTime() + 60_000);
    await Promise.all([first.probe(firstBad), second.probe(secondBad)]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    clock = new Date(now.getTime() + 6 * 60_000);
    await Promise.all([second.probe(firstBad), first.probe(secondBad)]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect((await first.probe(healthy)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    clock = new Date(now.getTime() + 15 * 60_000);
    expect((await second.probe(firstBad)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    const counters = await sql<{ day_used: number; retry_day_used: number }>`
      select day_used, retry_day_used from ai_funded_model_probe_budget
    `.execute(db.executor);
    expect(counters.rows).toEqual([{ day_used: 6, retry_day_used: 2 }]);
  });

  it("caps cached model readiness at relay-supplied pricing expiry and rejects missing expiry", async () => {
    let observedNow = new Date("2026-09-30T23:59:59.900Z");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z",
    })).mockResolvedValueOnce(Response.json({ ready: true }));
    const probes = createFundedModelProbeService({ db, relayBaseUrl: "https://relay.example.test",
      relayControlToken: "c".repeat(32), dailyLimit: 2, minuteLimit: 2,
      fetchFn, now: () => observedNow });
    const first = await probes.probe(sonnet);
    expect(first).toMatchObject({ ready: true, staleAfter: "2026-09-30T23:59:59.999Z" });
    observedNow = new Date("2026-10-01T00:00:00.100Z");
    expect((await probes.probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
