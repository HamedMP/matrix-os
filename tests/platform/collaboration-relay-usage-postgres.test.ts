import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { bootstrapPlatformCollaborationDatabase, type CollaborationPlatformDatabase } from "../../packages/platform/src/collaboration/database";
import { RelayUsageMeter } from "../../packages/platform/src/collaboration/relay-usage";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support";

it("bounds local daily usage and flushes metadata without route paths", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  let meter: RelayUsageMeter | undefined;
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    meter = new RelayUsageMeter({ db, now: () => Date.parse("2026-09-28T12:00:00.000Z"), startTimers: false });
    expect(await meter.canAdmit("user_local", true, 100)).toBe(true);
    expect(meter.record("user_local", true, { requests: 1, bytes: 90 }, 100)).toBe(false);
    expect(await meter.canAdmit("user_local", true, 100)).toBe(true);
    expect(meter.record("user_local", true, { bytes: 21 }, 100)).toBe(true);
    expect(await meter.canAdmit("user_local", true, 100)).toBe(false);
    await meter.close();
    meter = undefined;
    const row = await db.selectFrom("collaboration_relay_usage_daily").selectAll().executeTakeFirstOrThrow();
    expect(Number(row.bytes)).toBe(111);
    expect(Number(row.requests)).toBe(1);
    expect(Object.keys(row).sort()).toEqual(["account_class", "actor_id", "bytes", "refusals", "requests", "socket_opens", "usage_day"]);
  } finally {
    if (meter) await meter.close();
    await fixture.destroy();
  }
});

it("starts a new UTC day for an already-open socket without closing it or losing its bytes", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  let now = Date.parse("2026-09-28T23:59:59.000Z");
  const meter = new RelayUsageMeter({ db, now: () => now, startTimers: false });
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    expect(await meter.canAdmit("user_midnight", true, 100)).toBe(true);
    meter.record("user_midnight", true, { bytes: 90 }, 100);
    now = Date.parse("2026-09-29T00:00:01.000Z");
    expect(meter.record("user_midnight", true, { bytes: 10 }, 100)).toBe(false);
    await meter.flush();
    const rows = await db.selectFrom("collaboration_relay_usage_daily").select(["usage_day", "bytes"]).orderBy("usage_day").execute();
    expect(rows.map((row) => Number(row.bytes))).toEqual([90, 10]);
  } finally { await meter.close(); await fixture.destroy(); }
});

it("refreshes global usage on flush so a long-lived socket sees other instances", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  const now = () => Date.parse("2026-09-28T12:00:00.000Z");
  const first = new RelayUsageMeter({ db, now, startTimers: false });
  const second = new RelayUsageMeter({ db, now, startTimers: false });
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    expect(await first.canAdmit("user_shared", true, 100)).toBe(true);
    expect(await second.canAdmit("user_shared", true, 100)).toBe(true);
    second.record("user_shared", true, { bytes: 90 });
    await second.flush();
    expect(first.record("user_shared", true, { bytes: 21 }, 100)).toBe(false);
    await first.flush();
    expect(first.record("user_shared", true, { bytes: 1 }, 100)).toBe(true);
  } finally { await first.close(); await second.close(); await fixture.destroy(); }
});

it("bounds the shutdown flush if the database never settles", async () => {
  const meter = new RelayUsageMeter({ db: {} as Kysely<CollaborationPlatformDatabase>, startTimers: false });
  vi.spyOn(meter, "flush").mockImplementation(() => new Promise<void>(() => undefined));
  vi.useFakeTimers();
  try {
    const closed = meter.close();
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(closed).resolves.toBeUndefined();
  } finally { vi.useRealTimers(); }
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("relay usage on real Postgres", () => {
  const fixtures: CollaborationTestDatabase[] = [];
  const meters: RelayUsageMeter[] = [];
  afterEach(async () => {
    for (const meter of meters.splice(0)) await meter.close();
    for (const fixture of fixtures.splice(0)) await fixture.destroy();
  });

  it("adds concurrent instance flushes, admits against persisted plus local bytes, and prunes after 35 days", async () => {
    const fixture = await createRealCollaborationTestDatabase();
    fixtures.push(fixture);
    const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
    await bootstrapPlatformCollaborationDatabase(db);
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const first = new RelayUsageMeter({ db, now: () => now, startTimers: false });
    const second = new RelayUsageMeter({ db, now: () => now, startTimers: false });
    meters.push(first, second);
    expect(await first.canAdmit("user_meter", true, 100)).toBe(true);
    expect(await second.canAdmit("user_meter", true, 100)).toBe(true);
    first.record("user_meter", true, { bytes: 40, requests: 1 });
    second.record("user_meter", true, { bytes: 50, requests: 1 });
    await Promise.all([first.flush(), second.flush()]);
    const row = await db.selectFrom("collaboration_relay_usage_daily").selectAll().where("actor_id", "=", "user_meter").executeTakeFirstOrThrow();
    expect(Number(row.bytes)).toBe(90);
    expect(Number(row.requests)).toBe(2);
    expect(await first.canAdmit("user_meter", true, 100)).toBe(true);
    first.record("user_meter", true, { bytes: 11 });
    expect(await first.canAdmit("user_meter", true, 100)).toBe(false);
    await first.flush();
    await first.prune(Date.parse("2026-11-04T12:00:00.000Z"));
    expect(await db.selectFrom("collaboration_relay_usage_daily").select("actor_id").execute()).toEqual([]);
  });
});
