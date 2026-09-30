import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationCapabilityRepository } from "../../packages/gateway/src/collaboration/capability-repository.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createCollaborationTestDatabase, collaborationActors, collaborationIds } from "./collaboration-test-support.js";
import { createPlatformCollaborationTestDatabase, destroyPlatformCollaborationTestDatabase } from "../platform/collaboration-test-support.js";

it.each(["organization acceptance", "decline with active member", "decline with pending member", "decline with expired member", "decline with active organization", "decline with stale organization"])("projects %s using current grant access", async (scenario) => {
  const home = await createCollaborationTestDatabase();
  const platform = await createPlatformCollaborationTestDatabase();
  const now = new Date("2026-09-30T12:00:00Z");
  let worker: CollaborationDirectoryOutbox | undefined;
  try {
    await bootstrapChatDatabase(home.db);
    await bootstrapCollaborationDatabase(home.db);
    await bootstrapPlatformCollaborationDatabase(platform.collaborationDb);
    const timestamp = now.toISOString();
    await home.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope, owner_type: "personal", owner_id: collaborationActors.owner,
      organization_id: "org_matrix_team", kind: "folder", resource_id: "folder_drive",
      parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1, auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime, authority_generation: 1,
      execution_generation: null, execution_eligibility: null, deleted_at: null,
      created_at: timestamp, updated_at: timestamp,
    }).execute();
    await home.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope, actor_id: collaborationActors.owner, role: "owner", status: "accepted",
      organization_id: "org_matrix_team", invitation_id: null, invited_by: collaborationActors.owner,
      accepted_at: timestamp, expires_at: null, revision: 1, joined_at: timestamp,
      updated_at: timestamp, dispositioned_at: null,
    }).execute();
    const directory = new PlatformCollaborationRepository(platform.collaborationDb, { now: () => now });
    worker = new CollaborationDirectoryOutbox({ db: home.db, runtimeId: collaborationIds.runtime,
      platformBaseUrl: "https://platform.internal", serviceToken: "runtime-service-secret-0123456789abcdef",
      startTimer: false, now: () => now, fetchImpl: async (_url, init) => {
        await directory.applyDirectoryEvent(JSON.parse(init!.body as string));
        return new Response(null, { status: 204 });
      } });
    const grants = new CollaborationCapabilityRepository(home.db, { now: () => now, createId: randomUUID });
    const grant = await grants.createGrant({ scopeId: collaborationIds.scope, actorId: collaborationActors.owner,
      clientRequestId: randomUUID(), expectedRevision: 1, payloadHash: "a".repeat(64),
      audience: { kind: "organization" }, preset: "contributor", policyVersion: "v1" });
    expect(await worker.runOnce()).toBe(1);
    expect(await directory.getScopeActorStatus(collaborationIds.scope, collaborationActors.editor)).toBeNull();
    if (scenario !== "organization acceptance") {
      const organizationAccess = scenario.endsWith("organization");
      if (organizationAccess) {
        await grants.acceptGrant({ grantId: grant.grantId, actorId: collaborationActors.editor, membershipEvidenceEpoch: "1" });
        expect(await worker.runOnce()).toBe(1);
      }
      const current = await grants.resolveActorGrants(collaborationIds.scope, collaborationActors.editor);
      const memberGrant = await grants.createGrant({ scopeId: collaborationIds.scope, actorId: collaborationActors.owner,
        clientRequestId: randomUUID(), expectedRevision: Number(current!.scope.revision), payloadHash: "b".repeat(64),
        audience: { kind: "member", actorId: collaborationActors.editor }, preset: "viewer", policyVersion: "v1",
        ...(scenario === "decline with expired member" ? { expiresAt: new Date(now.getTime() + 1_000).toISOString() } : {}) });
      expect(await worker.runOnce()).toBe(1);
      if (!organizationAccess && scenario !== "decline with pending member") {
        await grants.acceptGrant({ grantId: memberGrant.grantId, actorId: collaborationActors.editor, membershipEvidenceEpoch: "1" });
        expect(await worker.runOnce()).toBe(1);
      }
      if (scenario === "decline with expired member") now.setTime(now.getTime() + 2_000);
      await grants.declineGrant({ grantId: organizationAccess ? memberGrant.grantId : grant.grantId,
        actorId: collaborationActors.editor, membershipEvidenceEpoch: scenario === "decline with stale organization" ? "2" : "1" });
      expect(await worker.runOnce()).toBe(1);
      expect(await directory.getScopeActorStatus(collaborationIds.scope, collaborationActors.editor))
        .toBe(["decline with active member", "decline with active organization"].includes(scenario) ? "accepted" : "revoked");
      return;
    }
    const decision = { grantId: grant.grantId, actorId: collaborationActors.editor, membershipEvidenceEpoch: "1" };
    await grants.acceptGrant(decision);
    expect(await worker.runOnce()).toBe(1);
    expect(await directory.getScopeActorStatus(collaborationIds.scope, collaborationActors.editor)).toBe("accepted");
    await grants.acceptGrant(decision);
    expect(await worker.runOnce()).toBe(0);
    await grants.endActorGrants({ organizationId: "org_matrix_team", actorId: collaborationActors.editor });
    expect(await worker.runOnce()).toBe(1);
    expect(await directory.getScopeActorStatus(collaborationIds.scope, collaborationActors.editor)).toBe("revoked");
  } finally {
    await worker?.shutdown();
    await home.destroy();
    await destroyPlatformCollaborationTestDatabase(platform);
  }
});
