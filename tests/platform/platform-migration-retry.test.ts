import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

function fixture() {
  const driver = new DummyDriver();
  const events: string[] = [];
  vi.spyOn(driver, "beginTransaction").mockImplementation(async () => { events.push("begin"); });
  vi.spyOn(driver, "rollbackTransaction").mockImplementation(async () => { events.push("rollback"); });
  vi.spyOn(driver, "commitTransaction").mockImplementation(async () => { events.push("commit"); });
  const db = new Kysely<Record<string, never>>({ dialect: {
    createDriver: () => driver,
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: database => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }, log: event => { if (event.level === "query") events.push(event.query.sql); } });
  return { db, events };
}

afterEach(() => vi.restoreAllMocks());

describe("platform migration retries", () => {
  it("rolls back a deadlock and reruns the entire migration under a fresh transaction and advisory lock", async () => {
    const { db, events } = fixture();
    const seen = new Set();
    const migrate = vi.fn(async trx => {
      seen.add(trx);
      await sql`select 1`.execute(trx);
      if (seen.size === 1) throw Object.assign(new Error("deadlock"), { code: "40P01" });
    });
    try {
      await expect(runPlatformMigration(db, migrate)).resolves.toBeUndefined();
      expect(migrate).toHaveBeenCalledTimes(2);
      expect(seen.size).toBe(2);
      expect(events.filter(event => event.includes("pg_advisory_xact_lock"))).toHaveLength(2);
      expect(events.filter(event => ["begin", "rollback", "commit"].includes(event))).toEqual(["begin", "rollback", "begin", "commit"]);
    } finally { await db.destroy(); }
  });

  it("bounds retries to three attempts and preserves the final failure", async () => {
    const { db } = fixture();
    const error = Object.assign(new Error("deadlock"), { code: "40P01" });
    const migrate = vi.fn().mockRejectedValue(error);
    try {
      await expect(runPlatformMigration(db, migrate)).rejects.toBe(error);
      expect(migrate).toHaveBeenCalledTimes(3);
    } finally { await db.destroy(); }
  });

  it("does not retry non-deadlock database errors", async () => {
    const { db } = fixture();
    const error = Object.assign(new Error("connection failure"), { code: "08006" });
    const migrate = vi.fn().mockRejectedValue(error);
    try {
      await expect(runPlatformMigration(db, migrate)).rejects.toBe(error);
      expect(migrate).toHaveBeenCalledTimes(1);
    } finally { await db.destroy(); }
  });
});
