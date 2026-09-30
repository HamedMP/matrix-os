import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { OrganizationAdminRepository, OrganizationCreateLimitError } from "../../packages/platform/src/organizations/admin-repository.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const actorId = "user_creator000000000000000";
const otherActor = "user_other00000000000000000";
const requestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";

describe.skipIf(!connectionString)("organization creation on real PostgreSQL", () => {
  let adminDb: Kysely<Record<string, never>>;
  let db: Kysely<OrganizationPlatformDatabase>;
  let schema: string;
  let clock: Date;
  let repository: OrganizationAdminRepository;

  beforeEach(async () => {
    if (!new URL(connectionString!).pathname.toLowerCase().includes("test")) {
      throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
    }
    schema = `org_create_${randomUUID().replaceAll("-", "")}`;
    adminDb = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
    db = new Kysely<OrganizationPlatformDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` }) }),
    });
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new OrganizationAdminRepository(db, { now: () => clock });
  });

  afterEach(async () => {
    await db?.destroy();
    if (adminDb && schema) await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
    await adminDb?.destroy();
  });

  it("inserts one request and charges one create under same-key concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => repository.beginCreate(actorId, requestId, "A team")));
    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(new Set(results.map((result) => result.request.clientRequestId))).toEqual(new Set([requestId]));
    const counter = await db.selectFrom("organization_admin_counters").select("count")
      .where("scope_id", "=", actorId).where("action", "=", "create").executeTakeFirstOrThrow();
    expect(counter.count).toBe(1);
    const count = await db.selectFrom("organization_admin_requests").select(({ fn }) => fn.countAll<number>().as("n"))
      .where("actor_id", "=", actorId).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it("enforces the daily counter and claim lease under concurrent distinct requests", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      repository.beginCreate(otherActor, `a77b8e1c-6112-4250-93d8-650d6fca8${String(index).padStart(3, "0")}`, `Team ${index}`)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason instanceof OrganizationCreateLimitError)).toHaveLength(9);
    const counter = await db.selectFrom("organization_admin_counters").select("count")
      .where("scope_id", "=", otherActor).where("action", "=", "create").executeTakeFirstOrThrow();
    expect(counter.count).toBe(3);
    clock = new Date(clock.getTime() + 2 * 60_000);
    const claims = await Promise.all([repository.claimDue(50), repository.claimDue(50)]);
    expect(claims.flat()).toHaveLength(3);
    expect(new Set(claims.flat().map((row) => row.clientRequestId)).size).toBe(3);
  });
});
