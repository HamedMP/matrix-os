import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database";
import { createAppInstanceAdapter } from "../../packages/gateway/src/collaboration/app-instance-adapter";
import { createProjectAppAdapter } from "../../packages/gateway/src/collaboration/project-app-adapter";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository";
import { allowAllOrganizationPrecondition, createCollaborationTestDatabase } from "./collaboration-test-support";

async function setup(kind: "app" | "project") {
  const fixture = await createCollaborationTestDatabase();
  await bootstrapChatDatabase(fixture.db);
  await bootstrapCollaborationDatabase(fixture.db);
  const catalog = new CollaborationResourceCatalog(fixture.db);
  const incarnation = "a".repeat(64), ownerId = "cas-owner", appId = "folio", projectId = "cas-project";
  const scopeId = randomUUID(), bindingId = randomUUID();
  const root = await catalog.register({ ownerId, projectId: null, kind: "app", path: appId, incarnation });
  const now = new Date("2026-10-06T12:00:00Z"), revision = kind === "app" ? root.revision : 2;
  await fixture.db.insertInto("collaboration_scopes").values({
    id: scopeId, owner_type: "personal", owner_id: ownerId, kind, organization_id: "org-cas",
    resource_id: kind === "app" ? root.id : projectId, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1,
    auth_epoch: 1, authority_runtime_id: "runtime-cas", authority_generation: 1, execution_generation: null,
    execution_eligibility: null, created_at: now, updated_at: now, deleted_at: null,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values({
    scope_id: scopeId, actor_id: ownerId, role: "owner", status: "accepted", invitation_id: null,
    invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1, joined_at: now, updated_at: now,
  }).execute();
  if (kind === "project") await fixture.db.insertInto("collaboration_resource_bindings").values({
    id: bindingId, project_scope_id: scopeId, resource_scope_id: null, resource_kind: "app", resource_id: appId,
    authority_runtime_id: "runtime-cas", authority_generation: 1, revision, readiness: "ready", blocker: null,
    incarnation, created_at: now, updated_at: now,
  }).execute();
  const authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
    now: () => now, organizationPrecondition: allowAllOrganizationPrecondition,
  });
  const bridge = { execute: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false })) };
  const onCommitted = vi.fn(async () => {});
  const options = { db: fixture.db, authority, bridge, now: () => now, onCommitted };
  const standalone = createAppInstanceAdapter({ ...options, catalog, apps: {
    resolve: async () => ({ projectId: null, appId, bridgeAppId: appId, collaborationMode: "scoped", incarnation }),
  } });
  const project = createProjectAppAdapter({ ...options, apps: {
    resolve: async () => ({ projectId, appId, bridgeAppId: appId, collaborationMode: "scoped", incarnation }),
  } });
  const context = await authority.authorize({ scopeId, actorId: ownerId, action: kind === "app" ? "mutate_resource" : "mutate_project" });
  const envelope = {
    clientRequestId: randomUUID(), expectedRevision: revision,
    action: { action: "compareAndSwap", app: appId, table: "records", id: "row-id",
      expectedPayload: { title: "Original" }, data: { payload: { title: "Edited" } } },
  };
  const mutate = (input = envelope) => kind === "app"
    ? standalone.mutate(context, appId, input) : project.mutate(context, { ...input, appId });
  const storedRevision = async () => kind === "app" ? (await catalog.get(root.id))!.revision
    : Number((await fixture.db.selectFrom("collaboration_resource_bindings").select("revision").where("id", "=", bindingId).executeTakeFirstOrThrow()).revision);
  const events = () => fixture.db.selectFrom("collaboration_events").selectAll().where("scope_id", "=", scopeId).execute();
  const operations = () => fixture.db.selectFrom("collaboration_operations").selectAll().where("scope_id", "=", scopeId).execute();
  return { fixture, bridge, onCommitted, envelope, mutate, revision, storedRevision, events, operations };
}

describe.each(["app", "project"] as const)("%s conditional mutation outcomes", kind => {
  it("stores and replays a failed comparison without changing revision or notifying subscribers", async () => {
    const f = await setup(kind);
    try {
      const expected = { result: { ok: false }, revision: f.revision, replayed: false };
      await expect(f.mutate()).resolves.toEqual(expected);
      expect(await f.storedRevision()).toBe(f.revision);
      expect(await f.events()).toEqual([]);
      expect(f.onCommitted).not.toHaveBeenCalled();
      expect(await f.operations()).toHaveLength(1);
      await expect(f.mutate()).resolves.toEqual({ ...expected, replayed: true });
      expect(f.bridge.execute).toHaveBeenCalledTimes(1);
      // A different successful request at the same revision remains admissible.
      f.bridge.execute.mockResolvedValueOnce({ ok: true });
      await expect(f.mutate({ ...f.envelope, clientRequestId: randomUUID() })).resolves.toEqual({ result: { ok: true }, revision: f.revision + 1, replayed: false });
      await expect(f.mutate()).resolves.toEqual({ ...expected, replayed: true });
      expect(await f.storedRevision()).toBe(f.revision + 1);
      expect(await f.events()).toHaveLength(1);
      expect(f.onCommitted).toHaveBeenCalledTimes(1);
      expect(f.bridge.execute).toHaveBeenCalledTimes(2);
      await expect(f.mutate({ ...f.envelope, action: { ...f.envelope.action, id: "another-row" } })).rejects.toMatchObject({ code: "conflict" });
    } finally { await f.fixture.destroy(); }
  });

  it("bumps and notifies exactly once for a successful comparison", async () => {
    const f = await setup(kind);
    try {
      f.bridge.execute.mockResolvedValueOnce({ ok: true });
      const expected = { result: { ok: true }, revision: f.revision + 1, replayed: false };
      await expect(f.mutate()).resolves.toEqual(expected);
      await expect(f.mutate()).resolves.toEqual({ ...expected, replayed: true });
      expect(await f.storedRevision()).toBe(f.revision + 1);
      const events = await f.events();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ revision: f.revision + 1, event_type: kind === "app" ? "resource.app.changed" : "project.app.changed" });
      expect(await f.operations()).toHaveLength(1);
      expect(f.onCommitted).toHaveBeenCalledTimes(1);
      expect(f.bridge.execute).toHaveBeenCalledTimes(1);
    } finally { await f.fixture.destroy(); }
  });

  it.each([{}, { ok: "false" }, null, { ok: false, extra: true }])("rejects malformed bridge outcome %j without persisting completion", async outcome => {
    const f = await setup(kind);
    try {
      f.bridge.execute.mockResolvedValueOnce(outcome);
      await expect(f.mutate()).rejects.toMatchObject({ code: "unavailable" });
      expect(await f.storedRevision()).toBe(f.revision);
      expect(await f.events()).toEqual([]);
      expect(await f.operations()).toEqual([]);
      expect(f.onCommitted).not.toHaveBeenCalled();
      // Failure did not poison idempotency: the same request can be retried safely.
      await expect(f.mutate()).resolves.toEqual({ result: { ok: false }, revision: f.revision, replayed: false });
    } finally { await f.fixture.destroy(); }
  });
});
