import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  createProxyDb,
  type ProxyDB,
} from "../../packages/proxy/src/db.js";

describe("proxy db (Postgres)", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: ProxyDB;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createProxyDb({ dialect: pglite.dialect });
    await db.ready;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("insertUsage + getUserUsage rolls up cost for a user", async () => {
    await db.insertUsage({
      userId: "alice", model: "opus-4", inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, status: 200,
    });
    await db.insertUsage({
      userId: "alice", model: "haiku", inputTokens: 5, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, status: 200,
    });

    const usage = await db.getUserUsage("alice");
    expect(usage.total).toBeCloseTo(0.052);
    expect(usage.daily).toBeCloseTo(0.052);
    expect(usage.monthly).toBeCloseTo(0.052);
  });

  it("setQuota upserts and checkQuota enforces daily limit", async () => {
    await db.setQuota("bob", 0.01, null);

    let check = await db.checkQuota("bob");
    expect(check.allowed).toBe(true);
    expect(check.dailyLimit).toBeCloseTo(0.01);

    await db.insertUsage({
      userId: "bob", model: "opus-4", inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, status: 200,
    });

    check = await db.checkQuota("bob");
    expect(check.allowed).toBe(false);
    expect(check.dailyUsed).toBeCloseTo(0.02);

    // setQuota again — verifies ON CONFLICT upsert path
    await db.setQuota("bob", 1.0, null);
    check = await db.checkQuota("bob");
    expect(check.allowed).toBe(true);
    expect(check.dailyLimit).toBeCloseTo(1.0);
  });

  it("checkQuota returns allowed=true for users with no quota row", async () => {
    const check = await db.checkQuota("never-seen");
    expect(check.allowed).toBe(true);
    expect(check.dailyLimit).toBeNull();
    expect(check.monthlyLimit).toBeNull();
  });

  it("getUsageSummary rolls up daily/monthly/total per user in a single query", async () => {
    await db.insertUsage({
      userId: "alice", model: "opus-4", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.10, status: 200,
    });
    await db.insertUsage({
      userId: "alice", model: "haiku", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, status: 200,
    });
    await db.insertUsage({
      userId: "bob", model: "opus-4", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50, status: 200,
    });

    const summary = await db.getUsageSummary();
    const alice = summary.find((u) => u.userId === "alice");
    const bob = summary.find((u) => u.userId === "bob");
    expect(alice).toMatchObject({ userId: "alice" });
    expect(alice?.total).toBeCloseTo(0.12);
    expect(alice?.daily).toBeCloseTo(0.12);
    expect(alice?.monthly).toBeCloseTo(0.12);
    expect(bob?.total).toBeCloseTo(0.50);
    expect(summary).toHaveLength(2);
  });

  it("getMetricsSeed groups by user_id and model", async () => {
    await db.insertUsage({
      userId: "alice", model: "opus-4", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.10, status: 200,
    });
    await db.insertUsage({
      userId: "alice", model: "opus-4", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, status: 200,
    });
    await db.insertUsage({
      userId: "bob", model: "haiku", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, status: 200,
    });

    const seed = await db.getMetricsSeed();
    const aliceOpus = seed.find((r) => r.user_id === "alice" && r.model === "opus-4");
    const bobHaiku = seed.find((r) => r.user_id === "bob" && r.model === "haiku");
    expect(aliceOpus?.calls).toBe(2);
    expect(aliceOpus?.cost).toBeCloseTo(0.15);
    expect(bobHaiku?.calls).toBe(1);
    expect(bobHaiku?.cost).toBeCloseTo(0.001);
  });
});
