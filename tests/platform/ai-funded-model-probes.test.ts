import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFundedModelProbeService, loadFundedModelProbeLimits, reserveFundedModelProbe } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";

const now = new Date("2026-09-25T12:00:00.000Z");
const sonnet = "anthropic/claude-sonnet-5";
const pricedReady = { ready: true, priceValidThrough: "2026-09-30T23:59:59.999Z" };

describe("fleet funded model probe budget", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

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

  it("coalesces repeated probes and retains the fleet count after service restart", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 1, minuteLimit: 1, fetchFn, now: () => now };
    const first = createFundedModelProbeService(input);
    const observations = await Promise.all(Array.from({ length: 5 }, () => first.probe(sonnet)));
    expect(observations.every((item) => item.ready)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await first.probe(sonnet)).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const restarted = createFundedModelProbeService(input);
    expect((await restarted.probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("admits only one paid call across concurrent Platform service instances", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricedReady));
    const input = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 1, minuteLimit: 1, fetchFn, now: () => now };
    const first = createFundedModelProbeService(input);
    const second = createFundedModelProbeService(input);
    const results = await Promise.all([first.probe(sonnet), second.probe(sonnet)]);
    expect(results.filter((result) => result.ready)).toHaveLength(1);
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
