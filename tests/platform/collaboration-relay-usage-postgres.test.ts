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

it("keeps computer owners admitted when the pending registry is full", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  const meter = new RelayUsageMeter({ db, now: () => Date.parse("2026-09-28T12:00:00.000Z"), startTimers: false });
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    const pending = (meter as unknown as { pending: Map<string, unknown> }).pending;
    for (let i = 0; i < 16_384; i++) pending.set(`user_${i}:2026-09-28`, {
      actorId: `user_${i}`, day: "2026-09-28", machineFree: true, knownBytes: 0, flushingBytes: 0,
      delta: { requests: 0, bytes: 1, socketOpens: 0, refusals: 0 }, lastTouched: 0,
    });
    expect(await meter.canAdmit("user_computer_owner", false, 100)).toBe(true);
    pending.clear();
  } finally { (meter as unknown as { pending: Map<string, unknown> }).pending.clear(); await meter.close(); await fixture.destroy(); }
});

it("keeps a live socket open and accounts for its bytes when the registry is full at midnight", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  let now = Date.parse("2026-09-28T23:59:59.000Z");
  const meter = new RelayUsageMeter({ db, now: () => now, startTimers: false });
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    meter.record("user_live", true, { bytes: 90 }, 100);
    const pending = (meter as unknown as { pending: Map<string, unknown> }).pending;
    for (let i = 1; i < 16_384; i++) pending.set(`user_${i}:2026-09-28`, {
      actorId: `user_${i}`, day: "2026-09-28", machineFree: true, knownBytes: 0, flushingBytes: 0,
      delta: { requests: 0, bytes: 1, socketOpens: 0, refusals: 0 }, lastTouched: 0,
    });
    now = Date.parse("2026-09-29T00:00:01.000Z");
    expect(meter.record("user_live", true, { bytes: 10 }, 100)).toBe(false);
    expect(pending.size).toBe(16_384);
    for (let i = 1; i < 16_384; i++) pending.delete(`user_${i}:2026-09-28`);
    await meter.flush();
    const rows = await db.selectFrom("collaboration_relay_usage_daily").select(["usage_day", "bytes"]).orderBy("usage_day").execute();
    expect(rows.map((row) => Number(row.bytes))).toEqual([90, 10]);
  } finally { (meter as unknown as { pending: Map<string, unknown> }).pending.clear(); await meter.close(); await fixture.destroy(); }
});

it("retains a live socket's actor slot after its usage has flushed", async () => {
  const fixture = await createCollaborationTestDatabase();
  const db = fixture.db as unknown as Kysely<CollaborationPlatformDatabase>;
  const meter = new RelayUsageMeter({ db, now: () => Date.parse("2026-09-28T12:00:00.000Z"), startTimers: false });
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    expect(await meter.canAdmit("user_live", true, 100)).toBe(true);
    const release = meter.retainSocket("user_live");
    meter.record("user_live", true, { socketOpens: 1 }, 100);
    await meter.flush();
    const pending = (meter as unknown as { pending: Map<string, unknown> }).pending;
    for (let i = 1; i < 16_384; i++) pending.set(`user_${i}:2026-09-28`, {
      actorId: `user_${i}`, day: "2026-09-28", machineFree: true, knownBytes: 0, flushingBytes: 0,
      delta: { requests: 0, bytes: 1, socketOpens: 0, refusals: 0 }, lastTouched: 0,
    });
    expect(await meter.canAdmit("user_new", true, 100)).toBe(false);
    release();
    expect(await meter.canAdmit("user_new", true, 100)).toBe(true);
  } finally { (meter as unknown as { pending: Map<string, unknown> }).pending.clear(); await meter.close(); await fixture.destroy(); }
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
