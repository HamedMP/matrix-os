import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import type { CollaborationResourceDriver } from "../../packages/gateway/src/collaboration/resource-actions.js";
import { StandaloneResourceScopeService } from "../../packages/gateway/src/collaboration/standalone-resource-scope.js";
import {
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const ownerId = "user_standalone_owner";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const firstOrganization = "org_standalone_first";
const secondOrganization = "org_standalone_second";
const incarnation = "a".repeat(64);

describe("standalone grant compatibility", () => {
  it("continues requiring an accepted grant for a standalone file scope", async () => {
    const fixture = await createCollaborationTestDatabase();
    const now = () => new Date("2026-11-05T00:00:00.000Z");
    const scopeId = randomUUID();
    const memberId = "user_standalone_member";
    try {
      await bootstrapChatDatabase(fixture.db);
      await bootstrapCollaborationDatabase(fixture.db);
      await fixture.db.insertInto("collaboration_scopes").values({
        id: scopeId,
        owner_type: "personal",
        owner_id: ownerId,
        organization_id: firstOrganization,
        kind: "file",
        resource_id: randomUUID(),
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "shared",
        revision: 1,
        auth_epoch: 1,
        authority_runtime_id: runtimeId,
        authority_generation: 1,
        execution_generation: null,
        execution_eligibility: null,
        deleted_at: null,
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      }).execute();
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId,
        actor_id: ownerId,
        role: "owner",
        status: "accepted",
        organization_id: firstOrganization,
        invitation_id: null,
        invited_by: ownerId,
        accepted_at: now().toISOString(),
        expires_at: null,
        revision: 1,
        joined_at: now().toISOString(),
        updated_at: now().toISOString(),
        dispositioned_at: null,
      }).execute();
      const grants = new CollaborationCapabilityRepository(fixture.db, { now, createId: randomUUID });
      const precondition = createOrganizationPrecondition({
        now,
        source: {
          async assertMembership({ organizationId, actorId }) {
            return organizationId === firstOrganization && (actorId === ownerId || actorId === memberId)
              ? { member: true, expiresAt: new Date(now().getTime() + 20_000).toISOString(), membershipEpoch: "1", aiSubmission: "owner_only" as const }
              : { member: false };
          },
        },
      });
      const evaluator = new CollaborationCapabilityEvaluator({ db: fixture.db, grants, organizationPrecondition: precondition, now });
      await expect(evaluator.evaluateEffectiveAccess({ scopeId, actorId: memberId }))
        .resolves.toMatchObject({ preset: null, actions: [], reasons: ["membership_required"] });
      const grant = await grants.createGrant({
        scopeId,
        actorId: ownerId,
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        payloadHash: "f".repeat(64),
        audience: { kind: "member", actorId: memberId },
        preset: "viewer",
        policyVersion: "standalone-v1",
      });
      await evaluator.acceptGrant({ grantId: grant.grantId, actorId: memberId });
      await expect(evaluator.evaluateEffectiveAccess({ scopeId, actorId: memberId }))
        .resolves.toMatchObject({ preset: "viewer", reasons: [] });
    } finally {
      await fixture.destroy();
    }
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("standalone catalog scope real Postgres", () => {
  let fixture: CollaborationTestDatabase;
  let catalog: CollaborationResourceCatalog;
  let service: StandaloneResourceScopeService;
  let resourceId: string;
  let observedIncarnation: string;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    catalog = new CollaborationResourceCatalog(fixture.db);
    resourceId = (await catalog.register({ ownerId, projectId: null, kind: "file",
      path: "notes.txt", incarnation })).id;
    observedIncarnation = incarnation;
    const driver = { inspect: async () => ({ incarnation: observedIncarnation }),
      resolveOwnerNamespace: async () => ({ projectId: null, path: "notes.txt" }) } as unknown as CollaborationResourceDriver;
    service = new StandaloneResourceScopeService({ resources: { catalog, driver }, runtimeId,
      preflightSecret: "b".repeat(32) });
  });

  afterEach(async () => { await fixture.destroy(); });

  it("serializes rival organization creates with one complete scope, member, event and operation", async () => {
    const first = await service.preflight({ ownerId, organizationId: firstOrganization, kind: "file", resourceId });
    const second = await service.preflight({ ownerId, organizationId: secondOrganization, kind: "file", resourceId });
    const attempts = await Promise.allSettled([
      service.create({ ownerId, organizationId: firstOrganization, kind: "file", resourceId,
        clientRequestId: randomUUID(), payloadHash: "1".repeat(64), expectedRevision: first.resourceRevision,
        confirmationToken: first.confirmationToken }),
      service.create({ ownerId, organizationId: secondOrganization, kind: "file", resourceId,
        clientRequestId: randomUUID(), payloadHash: "2".repeat(64), expectedRevision: second.resourceRevision,
        confirmationToken: second.confirmationToken }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const scopes = await fixture.db.selectFrom("collaboration_scopes").selectAll().where("resource_id", "=", resourceId).execute();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.lifecycle).toBe("shared");
    expect(Number(scopes[0]?.revision)).toBe(1);
    expect(Number(scopes[0]?.auth_epoch)).toBe(1);
    for (const table of ["collaboration_members", "collaboration_events", "collaboration_audit", "collaboration_operations", "collaboration_directory_outbox"] as const) {
      expect(await fixture.db.selectFrom(table).selectAll().where("scope_id", "=", scopes[0]!.id).execute()).toHaveLength(1);
    }
  });

  it("rejects changed incarnation before any scope write", async () => {
    const preflight = await service.preflight({ ownerId, organizationId: firstOrganization, kind: "file", resourceId });
    observedIncarnation = "c".repeat(64);
    await expect(service.create({ ownerId, organizationId: firstOrganization, kind: "file", resourceId,
      clientRequestId: randomUUID(), payloadHash: "3".repeat(64), expectedRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken })).rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.db.selectFrom("collaboration_scopes").select("id").where("resource_id", "=", resourceId).execute()).toEqual([]);
  });
});
