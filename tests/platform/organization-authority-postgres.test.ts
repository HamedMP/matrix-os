import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapPlatformOrganizationDatabase,
  type OrganizationPlatformDatabase,
} from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { applyClerkOrganizationEvent } from "../../packages/platform/src/organizations/commands.js";
import { createOrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import type { ClerkOrganizationSourceEvent } from "../../packages/platform/src/organizations/roles.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const org = "org_2test000000000000000000001";
const owner = "user_owner000000000000000000";
const member = "user_member0000000000000000";

function membershipEvent(input: {
  eventId: string;
  type: "organizationMembership.created" | "organizationMembership.updated" | "organizationMembership.deleted";
  actorId: string;
  role?: string;
  updatedAt: number;
  aiSubmission?: string;
}): ClerkOrganizationSourceEvent {
  return {
    eventId: input.eventId,
    type: input.type,
    occurredAt: new Date(input.updatedAt),
    organization: {
      organizationId: org,
      name: "Test org",
      slug: "test-org",
      aiSubmission: input.aiSubmission === "members" ? "members" : "owner_only",
      sourceUpdatedAt: new Date(input.updatedAt),
    },
    membership: {
      membershipId: `orgmem_${input.actorId}`,
      actorId: input.actorId,
      role: input.role ?? "org:member",
      sourceUpdatedAt: new Date(input.updatedAt),
    },
  };
}

describe.skipIf(!connectionString)("organization authority on real PostgreSQL (T015)", () => {
  let adminDb: Kysely<Record<string, never>>;
  let db: Kysely<OrganizationPlatformDatabase>;
  let schema: string;

  beforeEach(async () => {
    schema = `org_authority_${randomUUID().replaceAll("-", "")}`;
    adminDb = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
    db = new Kysely<OrganizationPlatformDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` }),
      }),
    });
    await bootstrapPlatformOrganizationDatabase(db);
  });

  afterEach(async () => {
    await db.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
    await adminDb.destroy();
  });

  it("applies a duplicated webhook exactly once and refuses a same-id different-payload replay", async () => {
    const repository = new PlatformOrganizationRepository(db);
    const event = membershipEvent({ eventId: "msg_dup", type: "organizationMembership.created", actorId: member, updatedAt: 1_000 });
    const first = await applyClerkOrganizationEvent(repository, event);
    const second = await applyClerkOrganizationEvent(repository, event);
    const forged = await applyClerkOrganizationEvent(repository, { ...event, membership: { ...event.membership!, role: "org:admin" } });
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(forged.outcome).toBe("conflict");
    const rows = await db.selectFrom("organization_memberships").select(["actor_id", "state", "role"]).execute();
    expect(rows).toEqual([{ actor_id: member, state: "active", role: "org:member" }]);
  });

  it("ignores a reordered older event after a newer one for the same membership", async () => {
    const repository = new PlatformOrganizationRepository(db);
    await applyClerkOrganizationEvent(repository, membershipEvent({ eventId: "msg_new", type: "organizationMembership.deleted", actorId: member, updatedAt: 5_000 }));
    const stale = await applyClerkOrganizationEvent(repository, membershipEvent({ eventId: "msg_old", type: "organizationMembership.created", actorId: member, updatedAt: 1_000 }));
    expect(stale.outcome).toBe("stale");
    const current = await repository.getMembership({ organizationId: org, actorId: member });
    expect(current?.state).toBe("removed");
  });

  it("removes then rejoins with a strictly increasing membership epoch and a new membership identity", async () => {
    const repository = new PlatformOrganizationRepository(db);
    const created = await applyClerkOrganizationEvent(repository, membershipEvent({ eventId: "m1", type: "organizationMembership.created", actorId: member, updatedAt: 1_000 }));
    const removed = await applyClerkOrganizationEvent(repository, membershipEvent({ eventId: "m2", type: "organizationMembership.deleted", actorId: member, updatedAt: 2_000 }));
    const rejoined = await applyClerkOrganizationEvent(repository, {
      ...membershipEvent({ eventId: "m3", type: "organizationMembership.created", actorId: member, updatedAt: 3_000 }),
      membership: { membershipId: "orgmem_second", actorId: member, role: "org:member", sourceUpdatedAt: new Date(3_000) },
    });
    expect(created.membershipEpoch).toBeLessThan(removed.membershipEpoch!);
    expect(removed.membershipEpoch).toBeLessThan(rejoined.membershipEpoch!);
    const current = await repository.getMembership({ organizationId: org, actorId: member });
    expect(current).toMatchObject({ state: "active", membershipId: "orgmem_second" });
    expect(removed.endedMemberships).toEqual([{ organizationId: org, actorId: member }]);
  });

  it("serializes concurrent webhooks for one organization so the epoch never regresses", async () => {
    const repository = new PlatformOrganizationRepository(db);
    const events = Array.from({ length: 12 }, (_, index) => membershipEvent({
      eventId: `c${index}`,
      type: index % 2 === 0 ? "organizationMembership.created" : "organizationMembership.deleted",
      actorId: `user_c${String(index % 3).padStart(24, "0")}`,
      updatedAt: 10_000 + index,
    }));
    const results = await Promise.all(events.map((event) => applyClerkOrganizationEvent(repository, event)));
    const epochs = results.filter((r) => r.outcome === "applied").map((r) => r.membershipEpoch!);
    expect(new Set(epochs).size).toBe(epochs.length);
    const organization = await repository.getOrganization(org);
    expect(organization?.membershipEpoch).toBe(Math.max(...epochs));
  });

  it("denies positive evidence during an upstream outage and restores it only after a fresh reconciliation", async () => {
    const repository = new PlatformOrganizationRepository(db);
    await applyClerkOrganizationEvent(repository, membershipEvent({ eventId: "o1", type: "organizationMembership.created", actorId: member, updatedAt: 1_000 }));
    let clock = new Date("2026-09-20T12:00:00.000Z");
    let upstreamAvailable = true;
    const projection = createOrganizationMembershipProjection({
      repository,
      now: () => clock,
      upstream: {
        async listMembers() {
          if (!upstreamAvailable) throw new Error("upstream down");
          return {
            organization: { organizationId: org, name: "Test org", slug: "test-org", aiSubmission: "owner_only", sourceUpdatedAt: new Date(1_000) },
            members: [{ membershipId: `orgmem_${member}`, actorId: member, role: "org:member", sourceUpdatedAt: new Date(1_000) }],
          };
        },
      },
    });
    // A webhook alone is not fresh positive authority.
    expect((await projection.assert({ organizationId: org, actorId: member, requestStartedAt: clock })).member).toBe(false);
    await projection.reconcile(org);
    const fresh = await projection.assert({ organizationId: org, actorId: member, requestStartedAt: clock });
    expect(fresh.member).toBe(true);
    expect(fresh.expiresAt.getTime() - clock.getTime()).toBe(20_000);
    // Outage: verification ages past the bound and evidence stops being positive.
    upstreamAvailable = false;
    clock = new Date(clock.getTime() + 61_000);
    await projection.reconcile(org);
    expect((await projection.assert({ organizationId: org, actorId: member, requestStartedAt: clock })).member).toBe(false);
    upstreamAvailable = true;
    await projection.reconcile(org);
    expect((await projection.assert({ organizationId: org, actorId: member, requestStartedAt: clock })).member).toBe(true);
    await projection.shutdown();
  });

  it("completes a denial only when every affected runtime acknowledges or its lease expires, under concurrent acks", async () => {
    const repository = new PlatformOrganizationRepository(db);
    let clock = new Date("2026-09-20T12:00:00.000Z");
    const authority = createCollaborationControlAuthority({
      repository,
      now: () => clock,
      leaseMs: 25_000,
      affectedRuntimes: async () => ["vps:10000000-0000-4000-8000-000000000001", "vps:10000000-0000-4000-8000-000000000002"],
    });
    const denial = await authority.fence({ organizationId: org, actorId: member, generation: 7 });
    expect(denial.state).toBe("pending");
    await Promise.all([
      authority.acknowledge("vps:10000000-0000-4000-8000-000000000001", { protocolVersion: 2, runtimeId: "vps:10000000-0000-4000-8000-000000000001", authorityGeneration: 7, fenceAt: clock.toISOString() }),
      authority.acknowledge("vps:10000000-0000-4000-8000-000000000001", { protocolVersion: 2, runtimeId: "vps:10000000-0000-4000-8000-000000000001", authorityGeneration: 7, fenceAt: clock.toISOString() }),
    ]);
    expect((await authority.describe(denial.denialId))?.state).toBe("pending");
    clock = new Date(clock.getTime() + 26_000);
    await authority.sweep();
    const completed = await authority.describe(denial.denialId);
    expect(completed?.state).toBe("completed");
    expect(completed?.acknowledgedAt).toBe(denial.ackDeadline);
    await authority.shutdown();
  });
});
