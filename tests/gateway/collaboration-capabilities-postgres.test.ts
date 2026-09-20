/**
 * S04 / T020: whole-project presets under the organization precondition.
 *
 * Runs against a dedicated PostgreSQL server when MATRIX_TEST_POSTGRES_URL is
 * set (races, locks) and against the PGlite fixture otherwise so CI covers
 * the same behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  CollaborationEffectiveAccessSchema,
  CollaborationReadinessSchema,
  expandCollaborationPreset,
} from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority-error.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationCapabilityEvaluator } from "../../packages/gateway/src/collaboration/capability-evaluator.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  createOrganizationPrecondition,
  type OrganizationMembershipSource,
} from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { dispositionLegacyMembers } from "../../packages/gateway/src/collaboration/policy-migrations.js";
import { evaluateCollaborationReadiness } from "../../packages/gateway/src/collaboration/readiness-evaluator.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationRepositoryError } from "../../packages/gateway/src/collaboration/repository-shared.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = "2026-09-20T12:00:00.000Z";
const ORG = "org_collaboration_primary";
const OTHER_ORG = "org_collaboration_other";
const members = new Map<string, Set<string>>([[ORG, new Set([
  collaborationActors.owner,
  collaborationActors.editor,
  collaborationActors.viewer,
])]]);
const newcomer = "user_collaboration_newcomer";
const hasRealPostgres = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);

function membershipSource(now: () => Date = () => new Date(NOW)): OrganizationMembershipSource {
  return {
    async assertMembership({ organizationId, actorId }) {
      return members.get(organizationId)?.has(actorId)
        ? { member: true, expiresAt: new Date(now().getTime() + 20_000).toISOString() }
        : { member: false };
    },
  };
}

function uuid(n: number): string {
  return `9${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
}
const HASH = "a".repeat(64);
let requestCounter = 0;
function request(expectedRevision: number) {
  requestCounter += 1;
  return { clientRequestId: uuid(requestCounter), expectedRevision, payloadHash: HASH };
}

describe("S04 capability grants and effective access", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;
  let grants: CollaborationCapabilityRepository;
  let evaluator: CollaborationCapabilityEvaluator;
  let clock = Date.parse(NOW);
  const now = () => new Date(clock);

  beforeEach(async () => {
    clock = Date.parse(NOW);
    members.set(ORG, new Set([collaborationActors.owner, collaborationActors.editor, collaborationActors.viewer]));
    fixture = hasRealPostgres ? await createRealCollaborationTestDatabase() : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now });
    grants = new CollaborationCapabilityRepository(fixture.db, { now, createId: () => crypto.randomUUID() });
    const precondition = createOrganizationPrecondition({ source: membershipSource(now), now });
    evaluator = new CollaborationCapabilityEvaluator({ db: fixture.db, grants, organizationPrecondition: precondition, now });
    await seedProject(fixture);
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("records the versioned migration and the two new tables", async () => {
    const versions = await fixture.db.selectFrom("collaboration_schema_migrations").select("version").execute();
    expect(versions.map((row) => Number(row.version))).toContain(8);
    await expect(sql`SELECT count(*) FROM collaboration_grants`.execute(fixture.db)).resolves.toBeTruthy();
    await expect(sql`SELECT count(*) FROM collaboration_grant_activations`.execute(fixture.db)).resolves.toBeTruthy();
  });

  describe("organization-wide shares stay pending per member", () => {
    it("denies a member who never opened the share and lists it as pending for them", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      expect(created.state).toBe("active");
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(CollaborationEffectiveAccessSchema.parse(access)).toMatchObject({ preset: null, actions: [], reasons: ["activation_required"] });
      expect(await grants.listParticipants(collaborationIds.scope)).toEqual([collaborationActors.owner]);
      const pending = await grants.listPendingForActor({ actorId: collaborationActors.editor, organizationId: ORG });
      expect(pending.map((item) => item.grantId)).toEqual([created.grantId]);
    });

    it("shows the pending share to a member who joins the organization later, without writing a row for them", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "viewer", policyVersion: "v1",
      });
      members.get(ORG)!.add(newcomer);
      const pending = await grants.listPendingForActor({ actorId: newcomer, organizationId: ORG });
      expect(pending.map((item) => item.grantId)).toEqual([created.grantId]);
      expect(await grants.listActivations(created.grantId)).toEqual([]);
    });

    it("activates through the accept call as one idempotent atomic transition, even under concurrent accepts", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor })));
      expect(results.every((result) => result.state === "active")).toBe(true);
      const activations = await grants.listActivations(created.grantId);
      expect(activations).toHaveLength(1);
      expect(activations[0]).toMatchObject({ actorId: collaborationActors.editor, state: "active" });
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(CollaborationEffectiveAccessSchema.parse(access)).toMatchObject({ preset: "contributor", reasons: [] });
      expect([...access.actions].sort()).toEqual([...expandCollaborationPreset("contributor")].sort());
      expect(await grants.listParticipants(collaborationIds.scope)).toEqual([collaborationActors.owner, collaborationActors.editor]);
      expect(await grants.listPendingForActor({ actorId: collaborationActors.editor, organizationId: ORG })).toEqual([]);
    });

    it("keeps a decline durable, refuses decline once active, and reactivates on a later accept with fresh metadata", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      await evaluator.declineGrant({ grantId: created.grantId, actorId: collaborationActors.viewer });
      expect(await grants.listPendingForActor({ actorId: collaborationActors.viewer, organizationId: ORG })).toEqual([]);
      expect(await grants.listParticipants(collaborationIds.scope)).toEqual([collaborationActors.owner]);
      const declined = (await grants.listActivations(created.grantId))[0]!;
      expect(declined).toMatchObject({ state: "declined", membershipEvidenceEpoch: expect.any(Number) });

      clock += 60_000;
      const reactivated = await evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.viewer });
      expect(reactivated.state).toBe("active");
      const rows = await grants.listActivations(created.grantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "active" });
      expect(Date.parse(rows[0]!.decidedAt)).toBe(clock);
      expect(rows[0]!.membershipEvidenceEpoch).toBeGreaterThan(declined.membershipEvidenceEpoch);

      await expect(evaluator.declineGrant({ grantId: created.grantId, actorId: collaborationActors.viewer }))
        .rejects.toMatchObject({ code: "conflict" });
    });

    it("never activates on a read", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "viewer", policyVersion: "v1",
      });
      await grants.getGrant(created.grantId);
      await grants.listPendingForActor({ actorId: collaborationActors.editor, organizationId: ORG });
      await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(await grants.listActivations(created.grantId)).toEqual([]);
    });
  });

  describe("member grants, conflicts, changes, expiry and revocation", () => {
    it("unions a member grant with an activated organization grant (deny-wins has no denies in V1)", async () => {
      const memberGrant = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
      });
      expect(memberGrant.state).toBe("pending");
      await evaluator.acceptGrant({ grantId: memberGrant.grantId, actorId: collaborationActors.editor });
      let access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access.preset).toBe("viewer");

      const orgGrant = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access.preset).toBe("viewer");
      await evaluator.acceptGrant({ grantId: orgGrant.grantId, actorId: collaborationActors.editor });
      access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access.preset).toBe("contributor");
    });

    it("changes a preset only with the expected grant revision and reflects it immediately", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "contributor", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor });
      await expect(grants.patchGrantPreset({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        grantId: created.grantId, expectedGrantRevision: 99, preset: "viewer",
      })).rejects.toMatchObject({ code: "conflict" });
      const patched = await grants.patchGrantPreset({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        grantId: created.grantId, expectedGrantRevision: created.grantRevision + 1, preset: "viewer",
      });
      expect(patched.grantRevision).toBe(created.grantRevision + 2);
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access.preset).toBe("viewer");
      const audit = await fixture.db.selectFrom("collaboration_audit").select("action").where("scope_id", "=", collaborationIds.scope).execute();
      expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["grant.created", "grant.accepted", "grant.preset_changed"]));
    });

    it("treats an expired grant as expired and a revoked grant as revoked", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "contributor", policyVersion: "v1",
        expiresAt: new Date(clock + 1_000).toISOString(),
      });
      await evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor });
      clock += 5_000;
      let access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access).toMatchObject({ preset: null, reasons: ["grant_expired"] });
      expect(await grants.expireGrants()).toBe(1);

      const second = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: second.grantId, actorId: collaborationActors.editor });
      await grants.revokeGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(3),
        grantId: second.grantId, expectedGrantRevision: second.grantRevision + 1,
      });
      access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access).toMatchObject({ preset: null, reasons: ["grant_revoked"] });
    });

    it("ends every grant on departure: the precondition denies before any allow is considered", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor });
      members.get(ORG)!.delete(collaborationActors.editor);
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access).toMatchObject({ preset: null, actions: [], reasons: ["precondition_denied"] });
      await expect(evaluator.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "chat.read" }))
        .rejects.toBeInstanceOf(CollaborationAuthorizationError);
      await expect(evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor }))
        .rejects.toBeInstanceOf(CollaborationAuthorizationError);
    });

    it("refuses a member grant for someone outside the organization and an organization grant on a scope without one", async () => {
      await expect(evaluator.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.outsider }, preset: "viewer", policyVersion: "v1",
      })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
      await fixture.db.updateTable("collaboration_scopes").set({ organization_id: null }).where("id", "=", collaborationIds.scope).execute();
      await expect(grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "viewer", policyVersion: "v1",
      })).rejects.toMatchObject({ code: "conflict" });
    });

    it("gives an admin no content privilege and an outsider nothing", async () => {
      members.get(ORG)!.add("user_org_admin");
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: "user_org_admin" });
      expect(access).toMatchObject({ preset: null, actions: [], reasons: ["membership_required"] });
      const outsider = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.outsider });
      expect(outsider).toMatchObject({ preset: null, actions: [], reasons: ["precondition_denied"] });
    });
  });

  describe("atomicity, replay and races", () => {
    it("replays an identical create and rejects a payload change under the same key", async () => {
      const input = {
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member" as const, actorId: collaborationActors.editor }, preset: "viewer" as const, policyVersion: "v1",
      };
      // PGlite serves one connection, so the concurrent replay race runs only on real PostgreSQL.
      const [first, second] = hasRealPostgres
        ? await Promise.all([grants.createGrant(input), grants.createGrant(input)])
        : [await grants.createGrant(input), await grants.createGrant(input)];
      expect(second).toEqual(first);
      expect(await countRows("collaboration_grants")).toBe(1);
      await expect(grants.createGrant({ ...input, payloadHash: "b".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    });

    it("commits grant, operation, audit and outbox together or not at all", async () => {
      await expect(grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(7),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
      })).rejects.toMatchObject({ code: "conflict" });
      expect(await countRows("collaboration_grants")).toBe(0);
      expect(await countRows("collaboration_operations")).toBe(0);
      expect(await countRows("collaboration_audit")).toBe(0);
      expect(await countRows("collaboration_directory_outbox")).toBe(0);
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
      });
      expect(created.scopeRevision).toBe(2);
      expect(await countRows("collaboration_operations")).toBe(1);
      expect(await countRows("collaboration_audit")).toBe(1);
      expect(await countRows("collaboration_directory_outbox")).toBe(1);
      const scope = await fixture.db.selectFrom("collaboration_scopes").select(["revision", "auth_epoch"]).where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow();
      expect(Number(scope.revision)).toBe(2);
      expect(Number(scope.auth_epoch)).toBe(2);
    });

    it("serializes revocation against acceptance so a revoked grant never activates", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1",
      });
      const outcomes = await Promise.allSettled([
        grants.revokeGrant({
          scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
          grantId: created.grantId, expectedGrantRevision: created.grantRevision,
        }),
        evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.editor }),
      ]);
      expect(outcomes[0].status).toBe("fulfilled");
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(access.preset).toBeNull();
      expect(await grants.listParticipants(collaborationIds.scope)).toEqual([collaborationActors.owner]);
    });

    it("caps grants per scope and requires the owner", async () => {
      await expect(grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.editor, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.viewer }, preset: "viewer", policyVersion: "v1",
      })).rejects.toMatchObject({ code: "forbidden" });
      const limited = new CollaborationCapabilityRepository(fixture.db, { now, createId: () => crypto.randomUUID(), maxGrantsPerScope: 1 });
      await limited.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
      });
      await expect(limited.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        audience: { kind: "member", actorId: collaborationActors.viewer }, preset: "viewer", policyVersion: "v1",
      })).rejects.toMatchObject({ code: "capacity" });
    });
  });

  describe("no permissive fallback", () => {
    it("denies with a generic reason when the membership source fails and with unavailable when policy lookup fails", async () => {
      const failing = createOrganizationPrecondition({
        source: { async assertMembership() { throw new Error("upstream down"); } }, now,
      });
      const guarded = new CollaborationCapabilityEvaluator({ db: fixture.db, grants, organizationPrecondition: failing, now });
      const access = await guarded.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.owner });
      expect(access).toMatchObject({ preset: null, actions: [], reasons: ["precondition_denied"] });

      const broken = new CollaborationCapabilityEvaluator({
        db: fixture.db,
        grants: { resolveActorGrants: async () => { throw new Error("connection refused"); } } as unknown as CollaborationCapabilityRepository,
        organizationPrecondition: createOrganizationPrecondition({ source: membershipSource(now), now }),
        now,
      });
      await expect(broken.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "chat.read" }))
        .rejects.toMatchObject({ code: "unavailable" });
      await expect(broken.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor }))
        .rejects.toMatchObject({ code: "unavailable" });
    });

    it("reports an unknown or unavailable scope without leaking existence", async () => {
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: uuid(4242), actorId: collaborationActors.owner });
      expect(access).toMatchObject({ preset: null, reasons: ["scope_unavailable"] });
      await expect(evaluator.requireAction({ scopeId: uuid(4242), actorId: collaborationActors.owner, action: "chat.read" }))
        .rejects.toMatchObject({ code: "not_found" });
    });

    it("denies everything with no membership source registered", async () => {
      const closed = new CollaborationCapabilityEvaluator({ db: fixture.db, grants, organizationPrecondition: createOrganizationPrecondition({ now }), now });
      const access = await closed.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.owner });
      expect(access).toMatchObject({ preset: null, actions: [], reasons: ["precondition_denied"] });
    });
  });

  describe("owner, legacy ceilings and authority integration", () => {
    it("gives the owner the full contributor expansion without a grant", async () => {
      const access = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.owner });
      expect(CollaborationEffectiveAccessSchema.parse(access)).toMatchObject({ preset: "contributor", reasons: [] });
    });

    it("dispositions legacy member rows explicitly with their exact old ceiling, never widening", async () => {
      await fixture.db.insertInto("collaboration_members").values([
        legacyMember(collaborationActors.editor, "editor"),
        legacyMember(collaborationActors.viewer, "viewer"),
      ]).execute();
      const before = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect(before.preset).toBeNull();
      const result = await dispositionLegacyMembers(fixture.db, { scopeId: collaborationIds.scope, actorId: collaborationActors.owner, now, createId: () => crypto.randomUUID() });
      expect(result).toMatchObject({ converted: 2 });
      expect(await dispositionLegacyMembers(fixture.db, { scopeId: collaborationIds.scope, actorId: collaborationActors.owner, now, createId: () => crypto.randomUUID() })).toMatchObject({ converted: 0 });
      const editor = await evaluator.decide({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor });
      expect([...editor.actions]).toEqual(expect.arrayContaining(["files.write", "discussion.post", "ai.submit"]));
      expect(editor.actions.has("git.push")).toBe(false);
      expect(editor.actions.has("git.commit")).toBe(false);
      // The wire summary is never wider than enforcement: a capped contributor reports the viewer preset.
      expect(CollaborationEffectiveAccessSchema.parse(editor.access).preset).toBe("viewer");
      await expect(evaluator.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "files.write" })).resolves.toBeTruthy();
      await expect(evaluator.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "git.push" })).rejects.toMatchObject({ code: "forbidden" });
      const viewer = await evaluator.evaluateEffectiveAccess({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer });
      expect(viewer.preset).toBe("viewer");
    });

    it("lets CollaborationAuthority honour grants: contributor maps to editor, viewer cannot request AI", async () => {
      const authority = new CollaborationAuthority(repository, {
        now,
        organizationPrecondition: createOrganizationPrecondition({ source: membershipSource(now), now }),
        capabilities: grants,
      });
      await expect(authority.authorize({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "discuss" }))
        .rejects.toMatchObject({ code: "not_found" });
      const contributor = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "contributor", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: contributor.grantId, actorId: collaborationActors.editor });
      await expect(authority.authorize({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "discuss" }))
        .resolves.toMatchObject({ role: "editor", organizationId: ORG });
      const viewerGrant = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(2),
        audience: { kind: "member", actorId: collaborationActors.viewer }, preset: "viewer", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: viewerGrant.grantId, actorId: collaborationActors.viewer });
      await expect(authority.authorize({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer, action: "read" }))
        .resolves.toMatchObject({ role: "viewer" });
      await expect(authority.authorize({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer, action: "discuss" }))
        .rejects.toMatchObject({ code: "forbidden" });
    });

    it("requires exact capability actions", async () => {
      const created = await grants.createGrant({
        scopeId: collaborationIds.scope, actorId: collaborationActors.owner, ...request(1),
        audience: { kind: "member", actorId: collaborationActors.viewer }, preset: "viewer", policyVersion: "v1",
      });
      await evaluator.acceptGrant({ grantId: created.grantId, actorId: collaborationActors.viewer });
      await expect(evaluator.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer, action: "files.read" })).resolves.toMatchObject({ preset: "viewer" });
      await expect(evaluator.requireAction({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer, action: "git.push" })).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  describe("readiness evaluator (T023)", () => {
    const probes = {
      hostOnline: async () => true,
      gitIdentity: async () => ({ configured: true, label: "Owner <owner@example.com>" }),
      forgeCredential: async () => ({ configured: true }),
      aiSource: async () => ({ configured: true, sourceKind: "owner_account" as const }),
      submitMode: async () => "members" as const,
      chatRootInventory: async () => ({ chatRootCount: 2, dirtyRootCount: 1, unresolved: 0 }),
      supported: async () => true,
    };

    it("reports ready for a project with every execution item", async () => {
      const readiness = await evaluateCollaborationReadiness({ resourceKind: "project", ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, probes);
      expect(CollaborationReadinessSchema.parse(readiness)).toMatchObject({ state: "ready", sourceKind: "owner_account", effectiveSubmitMode: "members", missingOwnerSetup: [] });
      expect(readiness.items.map((item) => item.item)).toEqual(["ai_source", "submit_mode", "git_identity", "chat_root_inventory"]);
    });

    it("reports missing owner setup items exactly", async () => {
      const readiness = await evaluateCollaborationReadiness({ resourceKind: "chat", ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, {
        ...probes, gitIdentity: async () => ({ configured: false }), aiSource: async () => ({ configured: false }),
      });
      expect(CollaborationReadinessSchema.parse(readiness)).toMatchObject({ state: "owner_setup_needed", missingOwnerSetup: ["git_identity", "ai_source"] });
      expect(readiness.sourceKind).toBeUndefined();
    });

    it("reports host offline before anything else and unsupported when the type cannot be served", async () => {
      const offline = await evaluateCollaborationReadiness({ resourceKind: "project", ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, { ...probes, hostOnline: async () => false });
      expect(CollaborationReadinessSchema.parse(offline)).toMatchObject({ state: "host_offline", missingOwnerSetup: [] });
      expect(offline.items.every((item) => item.status === "unavailable")).toBe(true);
      const unsupported = await evaluateCollaborationReadiness({ resourceKind: "app_instance", ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, { ...probes, supported: async () => false });
      expect(unsupported).toMatchObject({ state: "unsupported", items: [] });
    });

    it("reports no execution items and no source for files, folders, apps and terminals", async () => {
      for (const resourceKind of ["file", "folder", "app_instance", "terminal"] as const) {
        const readiness = await evaluateCollaborationReadiness({ resourceKind, ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, probes);
        expect(CollaborationReadinessSchema.parse(readiness)).toMatchObject({ state: "ready", items: [] });
        expect(readiness.sourceKind).toBeUndefined();
      }
    });

    it("fails closed to owner-only and marks unresolved roots when a probe fails", async () => {
      const readiness = await evaluateCollaborationReadiness({ resourceKind: "project", ownerId: collaborationActors.owner, scopeId: collaborationIds.scope, organizationId: ORG }, {
        ...probes,
        submitMode: async () => { throw new Error("projection unavailable"); },
        chatRootInventory: async () => ({ chatRootCount: 1, dirtyRootCount: 0, unresolved: 1 }),
      });
      expect(readiness.effectiveSubmitMode).toBe("owner_only");
      expect(readiness.items.find((item) => item.item === "chat_root_inventory")).toMatchObject({ status: "unavailable" });
      expect(readiness.items.find((item) => item.item === "submit_mode")).toMatchObject({ status: "unavailable" });
      expect(CollaborationReadinessSchema.parse(readiness).state).toBe("ready");
    });
  });

  async function countRows(table: "collaboration_grants" | "collaboration_operations" | "collaboration_audit" | "collaboration_directory_outbox"): Promise<number> {
    const row = await fixture.db.selectFrom(table).select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  function legacyMember(actorId: string, role: "editor" | "viewer") {
    return {
      scope_id: collaborationIds.scope, actor_id: actorId, role, status: "accepted" as const,
      organization_id: null, invitation_id: null, invited_by: collaborationActors.owner,
      accepted_at: NOW, expires_at: null, revision: 1, joined_at: NOW, updated_at: NOW,
    };
  }
});

async function seedProject(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    organization_id: ORG,
    kind: "project",
    resource_id: "project_collaboration_primary",
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: null,
    execution_eligibility: null,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values({
    scope_id: collaborationIds.scope,
    actor_id: collaborationActors.owner,
    role: "owner",
    status: "accepted",
    organization_id: ORG,
    invitation_id: null,
    invited_by: collaborationActors.owner,
    accepted_at: NOW,
    expires_at: null,
    revision: 1,
    joined_at: NOW,
    updated_at: NOW,
  }).execute();
}
void OTHER_ORG;
