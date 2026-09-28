import { createHmac, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrganizationAdminRepository, OrganizationInvitationLimitError } from "../../packages/platform/src/organizations/admin-repository.js";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const organizationId = "org_invites000000000000000";
const actorId = "user_admin000000000000000";
const invitationId = "orginv_00000000000000000000";
const secretBytes = Buffer.from("0123456789abcdef0123456789abcdef");
const signingSecret = `whsec_${secretBytes.toString("base64")}`;

describe.skipIf(!connectionString)("organization invitations on real PostgreSQL", () => {
  let adminDb: Kysely<Record<string, never>>;
  let db: Kysely<OrganizationPlatformDatabase>;
  let repository: OrganizationAdminRepository;
  let schema: string;
  let clock: Date;

  beforeEach(async () => {
    if (!new URL(connectionString!).pathname.toLowerCase().includes("test")) throw new Error("Use a dedicated test database");
    schema = `org_invite_${randomUUID().replaceAll("-", "")}`;
    adminDb = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
    db = new Kysely<OrganizationPlatformDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` }) }) });
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new OrganizationAdminRepository(db, { now: () => clock });
  });

  afterEach(async () => {
    await db?.destroy();
    if (adminDb && schema) await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
    await adminDb?.destroy();
  });

  function input(index = 0) {
    return {
      organizationId, actorId,
      addressDigest: repository.invitationDigest(`Member${index}@Example.com`, "test-platform-secret"),
      clientRequestId: `a77b8e1c-6112-4250-93d8-650d6fca8${String(index).padStart(3, "0")}`,
      role: "org:member" as const,
    };
  }

  it("lets only one concurrent request claim an address and charges both limits once", async () => {
    const same = input();
    expect(repository.invitationDigest(" member0@example.com ", "test-platform-secret")).toBe(same.addressDigest);
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.beginInvitation(same)));
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.every((result) => result.record.addressDigest === same.addressDigest)).toBe(true);
    const first = results.find((result) => result.claimed)!;
    await repository.completeInvitation(first.record, invitationId, new Date(clock.getTime() + 7 * 24 * 60 * 60_000));
    const replay = await repository.beginInvitation({ ...same, clientRequestId: randomUUID() });
    expect(replay.claimed).toBe(false);
    expect(replay.record.invitationId).toBe(invitationId);
    const counters = await db.selectFrom("organization_admin_counters").select(["action", "count"]).where("action", "in", ["invite_actor", "invite_org"]).execute();
    expect(counters).toHaveLength(2);
    expect(counters.map((row) => row.count)).toEqual([1, 1]);
    const persisted = await db.selectFrom("organization_invitation_records").select(["address_digest", "invitation_id"]).execute();
    expect(persisted).toEqual([{ address_digest: same.addressDigest, invitation_id: invitationId }]);
    expect(JSON.stringify(persisted)).not.toContain("member0@example.com");
  });

  it("deletes only the matching invitation, expires stale rows, and prunes counters", async () => {
    const first = await repository.beginInvitation(input());
    await repository.completeInvitation(first.record, invitationId, new Date(clock.getTime() + 1_000));
    await repository.deleteInvitation(organizationId, "orginv_other000000000000000");
    expect(await repository.getInvitation(organizationId, input().addressDigest)).not.toBeNull();
    const app = createPlatformOrganizationRoutes({
      repository: {} as never, adminRepository: repository, projection: {} as never, controlAuthority: {} as never,
      webhookSigningSecret: signingSecret, now: () => clock,
      resolveActor: async () => null, authenticateRuntime: async () => null,
    });
    const webhookBody = JSON.stringify({ type: "organizationInvitation.accepted", data: { id: invitationId, organization_id: organizationId }, timestamp: clock.getTime() });
    const timestamp = Math.floor(clock.getTime() / 1000);
    const deliveryId = "msg_invitation_pg";
    const webhook = await app.request("/webhooks/clerk/organizations", { method: "POST", body: webhookBody, headers: {
      "svix-id": deliveryId, "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${createHmac("sha256", secretBytes).update(`${deliveryId}.${timestamp}.${webhookBody}`).digest("base64")}`,
    } });
    expect(webhook.status).toBe(200);
    expect(await repository.getInvitation(organizationId, input().addressDigest)).toBeNull();
    await repository.beginInvitation(input(1));
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60_000);
    await repository.prune();
    expect(await db.selectFrom("organization_invitation_records").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("organization_admin_counters").selectAll().execute()).toHaveLength(0);
  });

  it("atomically caps invitations at 20 per actor per hour", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 22 }, (_, index) => repository.beginInvitation(input(index))));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(20);
    expect(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason instanceof OrganizationInvitationLimitError)).toHaveLength(2);
  });

  it("atomically caps an organization at 100 new invitations per day", async () => {
    const dayMs = 24 * 60 * 60_000;
    const windowStart = new Date(Math.floor(clock.getTime() / dayMs) * dayMs);
    await db.insertInto("organization_admin_counters").values({
      scope_id: organizationId, action: "invite_org", window_start: windowStart, count: 99,
    }).execute();
    expect((await repository.beginInvitation(input(1))).claimed).toBe(true);
    await expect(repository.beginInvitation({ ...input(2), actorId: "user_other000000000000000" }))
      .rejects.toBeInstanceOf(OrganizationInvitationLimitError);
    const count = await db.selectFrom("organization_admin_counters").select("count")
      .where("scope_id", "=", organizationId).where("action", "=", "invite_org").executeTakeFirstOrThrow();
    expect(count.count).toBe(100);
  });
});
