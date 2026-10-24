import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFundedModelProbeService, FUNDED_PROBE_MODELS, reserveFundedModelProbe,
} from "../../packages/platform/src/ai-funded-model-probes.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const MODEL = "@cf/zai-org/glm-5.3-flash";
const NOW = new Date("2026-10-25T00:00:00.000Z");
const priced = () => Response.json({ ready: true, priceValidThrough: "2026-10-30T00:00:00.000Z" });

describe("funded readiness count-budget diagnosis", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); });

  it("reuses current priced health even when no further probe budget is available", async () => {
    let clock = NOW;
    const reserveProbe = vi.fn(async () => true);
    const fetchFn = vi.fn<typeof fetch>(async () => priced());
    const options = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 10, minuteLimit: 10, reserveProbe, fetchFn, now: () => clock };
    const first = await createFundedModelProbeService(options).probe(MODEL);
    expect(first.ready).toBe(true);
    reserveProbe.mockResolvedValue(false);
    clock = new Date(+NOW + 30_001);
    expect(await createFundedModelProbeService(options).probe(MODEL)).toEqual(first);
    expect(reserveProbe).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock = new Date(+NOW + 300_000);
    expect((await createFundedModelProbeService(options).probe(MODEL)).ready).toBe(false);
    expect(reserveProbe).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("can produce ten negative joins without dispatch when admission denies every cold model", async () => {
    let clock = NOW;
    const reserveProbe = vi.fn(async () => false);
    const fetchFn = vi.fn<typeof fetch>(async () => priced());
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const options = { db, relayBaseUrl: "https://relay.example.test", relayControlToken: "c".repeat(32),
      dailyLimit: 10, minuteLimit: 10, reserveProbe, fetchFn, now: () => clock };
    const service = createFundedModelProbeService(options);
    const receiptId = "12345678-1234-4123-8123-123456789abc";
    expect((await Promise.all(FUNDED_PROBE_MODELS.map(id => service.probe(id, { receiptId }))))
      .every(result => !result.ready)).toBe(true);
    const events = info.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    const joins = events.filter(event => event.event === "funded_readiness_join");
    expect(joins).toHaveLength(10);
    expect(joins.every(event => event.ready === false && event.probeId === undefined)).toBe(true);
    expect(events.some(event => event.event === "funded_readiness_dispatch")).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();

    // Denial is a bounded negative observation, not a permanent health result.
    reserveProbe.mockResolvedValue(true);
    expect((await service.probe(MODEL)).ready).toBe(false);
    expect(reserveProbe).toHaveBeenCalledTimes(10);
    clock = new Date(+NOW + 5_000);
    expect((await service.probe(MODEL)).ready).toBe(true);
    expect(reserveProbe).toHaveBeenCalledTimes(11);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a changed same-day count configuration without increasing or resetting counters", async () => {
    expect(await reserveFundedModelProbe({ db, now: NOW, dailyLimit: 100, minuteLimit: 10 })).toBe(true);
    const read = () => sql<{ day_used: number; daily_limit: number; minute_used: number; minute_limit: number }>`
      select day_used, daily_limit, minute_used, minute_limit from ai_funded_model_probe_budget
    `.execute(db.executor);
    const before = await read();
    const nextMinute = new Date(+NOW + 60_000);
    expect(await reserveFundedModelProbe({ db, now: nextMinute, dailyLimit: 100, minuteLimit: 20 })).toBe(false);
    expect(await reserveFundedModelProbe({ db, now: nextMinute, dailyLimit: 200, minuteLimit: 10 })).toBe(false);
    expect((await read()).rows).toEqual(before.rows);
    expect(before.rows).toEqual([{ day_used: 1, daily_limit: 100, minute_used: 1, minute_limit: 10 }]);
  });
});
