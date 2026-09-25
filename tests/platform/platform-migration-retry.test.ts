import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

function fixture() {
  const driver = new DummyDriver();
  const events: string[] = [];
  let storedRevision: { generation: number; fingerprint: string } | undefined;
  const connection = { executeQuery: async (query: { sql: string; parameters: readonly unknown[] }) => {
    if (query.sql.includes("FROM platform_schema_revisions")) {
      return { rows: storedRevision ? [storedRevision] : [] };
    }
    if (query.sql.includes("INSERT INTO platform_schema_revisions")) {
      const incoming = { generation: Number(query.parameters[0]), fingerprint: String(query.parameters[1]) };
      if (!storedRevision || incoming.generation > storedRevision.generation) storedRevision = incoming;
    }
    return { rows: [] };
  }, async *streamQuery() {} };
  vi.spyOn(driver, "acquireConnection").mockResolvedValue(connection);
  vi.spyOn(driver, "beginTransaction").mockImplementation(async () => { events.push("begin"); });
  vi.spyOn(driver, "rollbackTransaction").mockImplementation(async () => { events.push("rollback"); });
  vi.spyOn(driver, "commitTransaction").mockImplementation(async () => { events.push("commit"); });
  const db = new Kysely<Record<string, never>>({ dialect: {
    createDriver: () => driver,
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: database => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }, log: event => { if (event.level === "query") events.push(event.query.sql); } });
  return { db, events, getStoredRevision: () => storedRevision };
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

  it("runs the current core schema only once across repeated platform starts", async () => {
    const { db, events, getStoredRevision } = fixture();
    const migrate = vi.fn(async trx => { await sql`ALTER TABLE golden_snapshots ADD COLUMN IF NOT EXISTS test_mode BOOLEAN`.execute(trx); });
    const first = { generation: 1, fingerprint: "schema-a" };
    const second = { generation: 2, fingerprint: "schema-b" };
    try {
      await runPlatformMigration(db, migrate, { revision: first });
      const firstMigrationQueries = events.filter(event => event.includes("ALTER TABLE golden_snapshots"));
      await runPlatformMigration(db, migrate, { revision: first });
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.includes("ALTER TABLE golden_snapshots"))).toEqual(firstMigrationQueries);
      expect(getStoredRevision()).toEqual(first);

      await runPlatformMigration(db, migrate, { revision: second });
      expect(migrate).toHaveBeenCalledTimes(2);
      expect(getStoredRevision()).toEqual(second);

      // A rollback or overlapping old revision must not move the marker back.
      await runPlatformMigration(db, migrate, { revision: first });
      expect(migrate).toHaveBeenCalledTimes(2);
      expect(getStoredRevision()).toEqual(second);
    } finally { await db.destroy(); }
  });

  it("fails closed on different fingerprints with the same generation", async () => {
    const { db } = fixture();
    const migrate = vi.fn(async () => undefined);
    try {
      await runPlatformMigration(db, migrate, { revision: { generation: 1, fingerprint: "schema-a" } });
      await expect(runPlatformMigration(db, migrate, {
        revision: { generation: 1, fingerprint: "schema-b" },
      })).rejects.toThrow("Conflicting platform schema fingerprints");
      expect(migrate).toHaveBeenCalledTimes(1);
    } finally { await db.destroy(); }
  });

  it("retries a deadlocked first versioned migration without marking it complete", async () => {
    const { db, getStoredRevision } = fixture();
    let attempts = 0;
    const migrate = vi.fn(async () => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("deadlock"), { code: "40P01" });
    });
    try {
      await expect(runPlatformMigration(db, migrate, {
        revision: { generation: 1, fingerprint: "schema-a" }, deadlockAttempts: 4,
      })).resolves.toBeUndefined();
      expect(migrate).toHaveBeenCalledTimes(4);
      expect(getStoredRevision()).toEqual({ generation: 1, fingerprint: "schema-a" });
    } finally { await db.destroy(); }
  });
});
