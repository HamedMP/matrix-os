import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database";
import { createAppInstanceAdapter } from "../../packages/gateway/src/collaboration/app-instance-adapter";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository";
import { allowAllOrganizationPrecondition, createCollaborationTestDatabase } from "./collaboration-test-support";

it("keeps standalone app compareAndSwap behind editor authorization and an exact app binding", async () => {
  const fixture = await createCollaborationTestDatabase();
  try {
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    const catalog = new CollaborationResourceCatalog(fixture.db);
    const incarnation = "a".repeat(64);
    const ownerId = "cas-owner", scopeId = randomUUID(), appId = "folio";
    const root = await catalog.register({ ownerId, projectId: null, kind: "app", path: appId, incarnation });
    const now = new Date("2026-10-06T12:00:00Z");
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, kind: "app", organization_id: "org-cas",
      resource_id: root.id, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1,
      auth_epoch: 1, authority_runtime_id: "runtime-cas", authority_generation: 1, execution_generation: null,
      execution_eligibility: null, created_at: now, updated_at: now, deleted_at: null,
    }).execute();
    for (const [actorId, role] of [[ownerId, "owner"], ["cas-editor", "editor"], ["cas-viewer", "viewer"]] as const)
      await fixture.db.insertInto("collaboration_members").values({ scope_id: scopeId, actor_id: actorId, role,
        status: "accepted", invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null,
        revision: 1, joined_at: now, updated_at: now }).execute();
    const authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), { now: () => now, organizationPrecondition: allowAllOrganizationPrecondition });
    const bridge = { execute: vi.fn(async () => ({ ok: true })) };
    const adapter = createAppInstanceAdapter({ db: fixture.db, authority, catalog, bridge, now: () => now,
      apps: { resolve: async (projectId, id) => projectId === null && id === appId
        ? { projectId, appId, bridgeAppId: appId, collaborationMode: "scoped", incarnation } : null } });
    const editor = await authority.authorize({ scopeId, actorId: "cas-editor", action: "mutate_resource" });
    const viewer = await authority.authorize({ scopeId, actorId: "cas-viewer", action: "read" });
    const action = { action: "compareAndSwap", app: appId, table: "records", id: "row-id",
      expectedPayload: { fields: { title: "Original" } }, data: { payload: { fields: { title: "Edited" } } } };
    const envelope = { clientRequestId: randomUUID(), expectedRevision: 0, action };
    await expect(adapter.query(editor, appId, action)).rejects.toMatchObject({ code: "invalid_action" });
    await expect(adapter.mutate(viewer, appId, envelope)).rejects.toMatchObject({ code: "forbidden" });
    await expect(adapter.mutate(editor, appId, { ...envelope, action: { ...action, app: "other" } })).rejects.toMatchObject({ code: "invalid_action" });
    expect(bridge.execute).not.toHaveBeenCalled();
    await expect(adapter.mutate(editor, appId, envelope)).resolves.toMatchObject({ result: { ok: true }, revision: 1 });
    expect(bridge.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: "cas-editor", storageSchema: appId,
      transaction: expect.anything(), action: expect.objectContaining({ action: "compareAndSwap", app: expect.stringMatching(/^s[a-f0-9]{32}$/), expectedPayload: action.expectedPayload }) }));
  } finally { await fixture.destroy(); }
});
