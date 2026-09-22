import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const org = "org_2upgr00000000000000000001";
const member = "user_member0000000000000000";

describe("organization database bootstrap upgrades", () => {
  let fixture: TestPlatformDb;
  let db: Kysely<OrganizationPlatformDatabase>;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
  });

  afterEach(async () => destroyTestPlatformDb(fixture.db));

  it("adds the claim columns to an outbox created by the previous revision", async () => {
    await sql`
      CREATE TABLE organization_revocation_outbox (
        intent_id UUID PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        membership_epoch BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        denial_id UUID,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        dead_letter BOOLEAN NOT NULL DEFAULT false
      )
    `.execute(db);
    await sql`
      INSERT INTO organization_revocation_outbox (intent_id, organization_id, actor_id, membership_epoch, next_attempt_at)
      VALUES ('10000000-0000-4000-8000-000000000001', ${org}, ${member}, 3, now() - interval '1 minute')
    `.execute(db);
    await bootstrapPlatformOrganizationDatabase(db);
    await bootstrapPlatformOrganizationDatabase(db);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'organization_revocation_outbox'
    `.execute(db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(["claimed_by", "claimed_until"]));
    const clock = new Date();
    const repository = new PlatformOrganizationRepository(db, { now: () => clock });
    const claimed = await repository.claimDueRevocationIntents({ now: clock, drainerId: "upgrader", leaseMs: 30_000, maxAttempts: 8 });
    expect(claimed).toMatchObject([{ intentId: "10000000-0000-4000-8000-000000000001", organizationId: org, actorId: member, attempts: 1 }]);
    expect(await repository.completeRevocationIntent({ intentId: "10000000-0000-4000-8000-000000000001", denialId: "10000000-0000-4000-8000-000000000001", drainerId: "upgrader" })).toBe(true);
  });
});
