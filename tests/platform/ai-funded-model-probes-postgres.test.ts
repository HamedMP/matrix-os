import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { createPlatformDb, type PlatformDB } from "../../packages/platform/src/db.js";
import { createFundedModelProbeService } from "../../packages/platform/src/ai-funded-model-probes.js";
import { createSharedFundedProbeCache, fundedProbeCacheKey } from "../../packages/platform/src/ai-funded-shared-probe-cache.js";

// Existing disposable-test-server convention: isolated schema, independent pools.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const sonnet = "anthropic/claude-sonnet-5";
const glm = "@cf/zai-org/glm-5.3-flash";
const origin = "https://relay.example.test";
const token = "c".repeat(32);

describe.skipIf(!databaseUrl)("shared model health on independent PostgreSQL connections", () => {
  let admin: pg.Pool;
  let schema: string;
  let db: PlatformDB;
  let secondDb: PlatformDB;
  let clock: Date;
  beforeEach(async () => {
    schema = `funded_probes_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = createPlatformDb(url.toString());
    await db.ready;
    secondDb = createPlatformDb(url.toString());
    await secondDb.ready;
    clock = new Date("2026-10-10T06:00:00.000Z");
  });
  afterEach(async () => {
    await secondDb?.destroy();
    await db?.destroy();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  function service(connection: PlatformDB, fetchFn: typeof fetch, overrides = {}) {
    return createFundedModelProbeService({ db: connection, relayBaseUrl: origin,
      relayControlToken: token, dailyLimit: 1000, minuteLimit: 2, fetchFn,
      now: () => new Date(clock), ...overrides });
  }
  function priced(expiry = "2026-10-15T00:00:00.000Z") {
    return Response.json({ ready: true, priceValidThrough: expiry });
  }
  async function budget() {
    return (await sql<{ day_used: number; minute_used: number }>`select day_used, minute_used
      from ai_funded_model_probe_budget`.execute(db.executor)).rows;
  }

  it("cache-only reads never reserve, dispatch, acquire leases or refresh observations", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    const cachedService = service(db, fetchFn);
    expect((await cachedService.readCached!(sonnet)).ready).toBe(false);
    expect(await budget()).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    const first = await cachedService.probe(sonnet);
    const rows = (await sql`select * from ai_funded_model_probe_cache`.execute(db.executor)).rows;
    expect(await service(secondDb, fetchFn).readCached!(sonnet)).toEqual(first);
    expect((await sql`select * from ai_funded_model_probe_cache`.execute(db.executor)).rows).toEqual(rows);
    clock = new Date("2026-10-10T06:05:00.000Z");
    expect((await cachedService.readCached!(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{ day_used: 1, minute_used: 1 }]);
  });

  it("creates its additive schema despite a newer core marker without resetting budget counters", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    await service(db, fetchFn).probe(sonnet);
    const before = await budget();
    await sql`update platform_schema_revisions set generation = 999, fingerprint = 'newer-preview' where scope='core'`.execute(db.executor);
    await sql`drop table ai_funded_model_probe_cache`.execute(db.executor);
    await sql`delete from platform_schema_revisions where scope='funded-probe-cache'`.execute(db.executor);
    await runPlatformStartupMigrations(secondDb.kysely);
    expect((await sql`select to_regclass('ai_funded_model_probe_cache')::text as name`.execute(db.executor)).rows[0]).toMatchObject({ name: "ai_funded_model_probe_cache" });
    expect((await sql`select generation,fingerprint from platform_schema_revisions where scope='core'`.execute(db.executor)).rows[0]).toEqual({ generation: 999, fingerprint: "newer-preview" });
    expect(await budget()).toEqual(before);
  });

  it("shares sequential, restarted and ten concurrent replicas without another paid budget slot", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchFn = vi.fn<typeof fetch>(async () => { entered.resolve(); await release.promise; return priced(); });
    const replicas = Array.from({ length: 10 }, (_, i) => service(i % 2 ? secondDb : db, fetchFn));
    const responses = replicas.map(replica => replica.probe(sonnet));
    await entered.promise;
    release.resolve();
    const results = await Promise.all(responses);
    expect(results.every(result => result.ready)).toBe(true);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await service(secondDb, fetchFn).probe(sonnet)).toEqual(results[0]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{ day_used: 1, minute_used: 1 }]);
  });

  it("retains the original provider observation across thirty seconds, but expires at five minutes", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    const first = await service(db, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet);
    expect(first.staleAfter).toBe("2026-10-10T06:05:00.000Z");
    clock = new Date(clock.getTime() + 30_001);
    expect(await service(secondDb, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet)).toEqual(first);
    clock = new Date("2026-10-10T06:04:59.999Z");
    expect(await service(secondDb, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet)).toEqual(first);
    clock = new Date("2026-10-10T06:05:00.000Z");
    expect((await service(secondDb, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never shares different model, normalized origin, control credential or probe configuration", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    const first = await service(db, fetchFn).probe(sonnet);
    expect(await service(secondDb, fetchFn, { relayBaseUrl: `${origin}/` }).probe(sonnet)).toEqual(first);
    expect((await service(secondDb, fetchFn).probe(glm)).ready).toBe(true);
    for (const overrides of [{ relayBaseUrl: "https://other.example.test" },
      { relayControlToken: "d".repeat(32) }, { minuteLimit: 1 }]) {
      expect((await service(secondDb, fetchFn, overrides).readCached!(sonnet)).ready).toBe(false);
      expect((await service(secondDb, fetchFn, overrides).probe(sonnet)).ready).toBe(false);
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const keys = await sql<{ cache_key: string }>`select cache_key from ai_funded_model_probe_cache`.execute(db.executor);
    expect(keys.rows.every(row => /^[a-f0-9]{64}$/.test(row.cache_key))).toBe(true);
  });

  it("price expiry is stricter than the shared health horizon", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced("2026-10-10T06:00:35.000Z"));
    const first = await service(db, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet);
    expect(first.staleAfter).toBe("2026-10-10T06:00:35.000Z");
    clock = new Date("2026-10-10T06:00:35.000Z");
    expect((await service(secondDb, fetchFn, { dailyLimit: 1, minuteLimit: 1 }).probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed on database failure despite a previously successful local result", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    const first = service(db, fetchFn);
    expect((await first.probe(sonnet)).ready).toBe(true);
    await sql`drop table ai_funded_model_probe_cache`.execute(db.executor);
    expect((await first.readCached!(sonnet)).ready).toBe(false);
    expect((await service(secondDb, fetchFn).readCached!(sonnet)).ready).toBe(false);
    expect((await first.probe(sonnet)).ready).toBe(false);
    expect((await service(secondDb, fetchFn).probe(sonnet)).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("cancels an abandoned paid fetch and prevents a remote waiter repeating its spent attempt", async () => {
    const entered = Promise.withResolvers<void>();
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return priced();
    });
    const controller = new AbortController();
    const first = service(db, fetchFn).probe(sonnet, { signal: controller.signal });
    await entered.promise;
    const remote = service(secondDb, fetchFn).probe(sonnet);
    controller.abort();
    expect((await first).ready).toBe(false);
    expect((await remote).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{ day_used: 1, minute_used: 1 }]);
  });

  it("fences a late writer after another connection replaces its expired lease", async () => {
    const key = fundedProbeCacheKey({ modelId: sonnet, relayOrigin: origin, controlToken: token, dailyLimit: 1000, minuteLimit: 2 });
    const firstCache = createSharedFundedProbeCache({ db, now: () => clock });
    const secondCache = createSharedFundedProbeCache({ db: secondDb, now: () => clock });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oldResult = { ready: true, priceValidThrough: "2026-10-15T00:00:00.000Z", checkedAt: clock.toISOString(), staleAfter: new Date(clock.getTime() + 300_000).toISOString() };
    const unavailable = () => ({ ready: false, checkedAt: clock.toISOString(), staleAfter: new Date(clock.getTime() + 5_000).toISOString() });
    const old = firstCache.probe(key, AbortSignal.timeout(3000), async () => {
      entered.resolve(); await release.promise; return oldResult;
    }, unavailable);
    await entered.promise;
    await sql`update ai_funded_model_probe_cache set lease_until = statement_timestamp() - interval '1 second'`.execute(secondDb.executor);
    clock = new Date(clock.getTime() + 1);
    const newerResult = { ...oldResult, checkedAt: clock.toISOString(), staleAfter: new Date(clock.getTime() + 300_000).toISOString() };
    expect(await secondCache.probe(key, AbortSignal.timeout(3000), async () => newerResult, unavailable)).toEqual(newerResult);
    release.resolve();
    expect((await old).ready).toBe(false);
    const repeatedRun = vi.fn(async () => oldResult);
    expect(await firstCache.probe(key, AbortSignal.timeout(3000), repeatedRun, unavailable)).toEqual(newerResult);
    expect(repeatedRun).not.toHaveBeenCalled();
  });

  it("evicts expired abandoned rows, caps active rows and never fetches when full", async () => {
    await sql`insert into ai_funded_model_probe_cache(cache_key, lease_token, lease_until)
      select lpad(to_hex(i),64,'0'), ${randomUUID()}::uuid, statement_timestamp() + interval '1 hour'
      from generate_series(1,128) as i`.execute(db.executor);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => priced());
    expect((await service(secondDb, fetchFn).probe(sonnet)).ready).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    await sql`update ai_funded_model_probe_cache set lease_until = statement_timestamp() - interval '1 second'`.execute(db.executor);
    expect((await service(secondDb, fetchFn).probe(sonnet)).ready).toBe(true);
    const rows = await sql<{ count: number }>`select count(*)::int as count from ai_funded_model_probe_cache`.execute(db.executor);
    expect(rows.rows[0].count).toBe(1);
  });
});
