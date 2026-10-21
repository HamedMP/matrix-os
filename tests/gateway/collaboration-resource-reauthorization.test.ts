import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationResourceCatalog, ResourceCatalogError } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION } from "../../packages/gateway/src/collaboration/resource-reauthorization.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
const ownerId = "user_reauthorize_owner", org = "org_reauthorize", runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const oldIdentity = "a".repeat(64), currentIdentity = "b".repeat(64);
const key = "r".repeat(32);
describe("explicit owner reauthorization of existing legacy shares", () => {
  let fixture: CollaborationTestDatabase;
  let catalog: CollaborationResourceCatalog;
  let inspect: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createCollaborationRoutes>;
  let identity: Map<string, string>;
  let scopeId: string, resourceId: string;
  const signer = new CollaborationProofSigner({ activeKeyId: "reauth", keys: { reauth: key }, createNonce: () => randomUUID().replaceAll("-", "") });
  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db); await bootstrapCollaborationDatabase(fixture.db);
    catalog = new CollaborationResourceCatalog(fixture.db);
    identity = new Map([["notes.txt", currentIdentity]]);
    inspect = vi.fn(async ({ path }: { path: string }) => {
      if (!identity.has(path)) throw new ResourceCatalogError("not_found");
      return { incarnation: identity.get(path)! };
    });
    scopeId = randomUUID();
    resourceId = (await catalog.register({ ownerId, projectId: null, kind: "file", path: "notes.txt", incarnation: oldIdentity })).id;
    await scope(scopeId, resourceId, "file");
    app = createCollaborationRoutes({ runtimeId, verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { reauth: key } }),
      resources: { catalog, driver: { inspect } },
    } as unknown as CollaborationRouteOptions);
  });
  afterEach(async () => { await fixture.destroy(); });
  async function scope(id: string, resource: string, kind: "file" | "folder" | "app" | "project") {
    const timestamp = new Date();
    await fixture.db.insertInto("collaboration_scopes").values({ id, owner_type: "personal", owner_id: ownerId, organization_id: org,
      kind, resource_id: resource, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1, auth_epoch: 1,
      authority_runtime_id: runtimeId, authority_generation: 1, execution_generation: null, execution_eligibility: null,
      created_at: timestamp, updated_at: timestamp, deleted_at: null }).execute();
    for (const [actorId, role] of [[ownerId, "owner"], ["user_reauthorize_recipient", "viewer"]] as const)
      await fixture.db.insertInto("collaboration_members").values({ scope_id: id, actor_id: actorId, role, status: "accepted", organization_id: org,
        invitation_id: null, invited_by: ownerId, accepted_at: timestamp, expires_at: null, revision: 1, joined_at: timestamp, updated_at: timestamp }).execute();
  }
  const request = () => ({ scopeId, kind: "file", organizationId: org });
  const confirmation = () => ({ ...request(), projectId: null, expectedRevision: "0", currentIncarnation: currentIdentity, confirmCurrentObject: true });
  async function call(action: "inspect" | "confirm", body: unknown, options: { actorId?: string; resource?: string; runtime?: string; unsigned?: boolean } = {}) {
    const path = `/api/collaboration/runtimes/${options.runtime ?? runtimeId}/catalog/${options.resource ?? resourceId}/reauthorization/${action}`;
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const proof = signer.signHttp({ actorId: options.actorId ?? ownerId, ownerId, runtimeId, method: "POST", path, query: "", body: bytes });
    return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(options.unsigned ? {} : {
      "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
    }) }, body: new TextDecoder().decode(bytes) });
  }
  it("inspects current identity without rotating a legacy catalog ID or changing links", async () => {
    const before = await catalog.get(resourceId);
    const response = await call("inspect", request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scopeId, resourceId, kind: "file", path: "notes.txt", projectId: null, expectedRevision: "0", currentIncarnation: currentIdentity });
    expect(await catalog.get(resourceId)).toEqual(before);
  });
  it("updates only the exact existing catalog identity after explicit confirmation; grants and scope remain unchanged", async () => {
    const beforeScopes = await fixture.db.selectFrom("collaboration_scopes").selectAll().execute();
    const beforeMembers = await fixture.db.selectFrom("collaboration_members").selectAll().orderBy("actor_id").execute();
    const response = await call("confirm", confirmation());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scopeId, entry: { id: resourceId, incarnation: currentIdentity, revision: "1" } });
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().execute()).toEqual(beforeScopes);
    expect(await fixture.db.selectFrom("collaboration_members").selectAll().orderBy("actor_id").execute()).toEqual(beforeMembers);
    expect((await catalog.get(resourceId))?.deletedAt).toBeNull();
    expect((await fixture.db.selectFrom("collaboration_audit").select("detail").executeTakeFirstOrThrow()).detail)
      .toEqual({ catalogId: resourceId, kind: "file", descendantsInvalidated: 0 });
    expect(await fixture.db.selectFrom("collaboration_audit").select(["scope_id", "actor_id", "action", "outcome", "revision"]).execute()).toEqual([
      { scope_id: scopeId, actor_id: ownerId, action: "resource.reauthorize", outcome: "completed", revision: 1 },
    ]);
    expect((await call("confirm", confirmation())).status).toBe(409);
  });
  it("authenticates owner/runtime before exposing current physical identity", async () => {
    expect((await call("inspect", request(), { actorId: "user_reauthorize_recipient" })).status).toBe(403);
    expect((await call("inspect", request(), { unsigned: true })).status).toBe(401);
    expect((await call("confirm", confirmation(), { runtime: "runtime_wrong" })).status).toBe(403);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("rejects new resources, wrong organization, app identities and mismatched namespaces", async () => {
    expect((await call("confirm", confirmation(), { resource: randomUUID() })).status).toBe(404);
    expect((await call("confirm", { ...confirmation(), organizationId: "org_other" })).status).toBe(404);
    expect((await call("confirm", { ...confirmation(), projectId: "project_other" })).status).toBe(409);
    expect((await call("confirm", { ...confirmation(), kind: "app" })).status).toBe(400);
    expect(await fixture.db.selectFrom("collaboration_resource_catalog").selectAll().execute()).toHaveLength(1);
  });
  it("rejects false/omitted confirmation, unknown authority fields, malformed revisions and malformed identities", async () => {
    for (const change of [{ confirmCurrentObject: false }, { confirmCurrentObject: undefined }, { role: "owner" }, { expectedRevision: "9007199254740992" }, { currentIncarnation: "legacy-identity" }])
      expect((await call("confirm", { ...confirmation(), ...change })).status).toBe(400);
    expect((await catalog.get(resourceId))?.incarnation).toBe(oldIdentity);
  });
  it("rechecks current physical identity and leaves catalog untouched after replacement or inspection error", async () => {
    await call("inspect", request()); identity.set("notes.txt", "c".repeat(64));
    expect((await call("confirm", confirmation())).status).toBe(409);
    inspect.mockRejectedValueOnce(new ResourceCatalogError("unavailable"));
    expect((await call("confirm", confirmation())).status).toBe(503);
    expect((await catalog.get(resourceId))?.incarnation).toBe(oldIdentity);
  });
  it("does not revive deleted entries or authorize a catalog row through another scope", async () => {
    expect((await call("confirm", { ...confirmation(), scopeId: randomUUID() })).status).toBe(404);
    await catalog.remove({ id: resourceId, expectedRevision: 0 });
    expect((await call("confirm", confirmation())).status).toBe(404);
    expect(await catalog.get(resourceId)).toBeNull();
  });
  it.each(["file", "folder"] as const)("recovers unscoped catalog ancestors top-down through the existing standalone %s scope", async (rootKind) => {
    const top = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "tree", incarnation: oldIdentity });
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "tree/parent", incarnation: oldIdentity });
    const child = await catalog.register({ ownerId, projectId: null, kind: rootKind, path: "tree/parent/root", incarnation: oldIdentity });
    const sibling = await catalog.register({ ownerId, projectId: null, kind: "file", path: "tree/sibling", incarnation: oldIdentity });
    const siblingFolder = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "tree/neighbor", incarnation: oldIdentity });
    const otherNamespace = await catalog.register({ ownerId, projectId: "project_other", kind: "folder", path: "tree", incarnation: oldIdentity });
    const descendant = rootKind === "folder" ? await catalog.register({ ownerId, projectId: null, kind: "file", path: "tree/parent/root/leaf", incarnation: oldIdentity }) : null;
    const topIdentity = "c".repeat(64), parentIdentity = "d".repeat(64);
    identity.set("tree", topIdentity); identity.set("tree/parent", parentIdentity); identity.set(child.path, currentIdentity);
    resourceId = child.id; scopeId = randomUUID(); await scope(scopeId, resourceId, rootKind);
    const beforeScopes = await fixture.db.selectFrom("collaboration_scopes").selectAll().orderBy("id").execute();
    expect((await call("inspect", { ...request(), kind: rootKind })).status).toBe(409);
    expect((await call("confirm", { ...confirmation(), kind: rootKind })).status).toBe(409);
    for (const [entry, kind] of [[sibling, "file"], [siblingFolder, "folder"], [otherNamespace, "folder"]] as const) {
      expect((await call("inspect", { ...request(), kind }, { resource: entry.id })).status).toBe(404);
      expect((await call("confirm", { ...confirmation(), kind }, { resource: entry.id })).status).toBe(404);
    }
    expect((await call("inspect", { ...request(), kind: "folder" }, { resource: parent.id })).status).toBe(409);
    const inspected = await call("inspect", { ...request(), kind: "folder" }, { resource: top.id });
    expect(inspected.status).toBe(200); expect(await inspected.json()).toMatchObject({ resourceId: top.id, expectedRevision: "0", currentIncarnation: topIdentity });
    expect((await call("confirm", { ...confirmation(), kind: "folder", currentIncarnation: topIdentity }, { resource: top.id })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect((await call("inspect", { ...request(), kind: "folder" }, { resource: parent.id })).status).toBe(200);
    expect((await call("confirm", { ...confirmation(), kind: "folder", expectedRevision: "1", currentIncarnation: parentIdentity }, { resource: parent.id })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ revision: 2, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect((await call("inspect", { ...request(), kind: rootKind })).status).toBe(200);
    expect((await call("confirm", { ...confirmation(), kind: rootKind, expectedRevision: "2" })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ id: child.id, revision: 3, incarnation: currentIdentity });
    expect(await catalog.get(sibling.id)).toMatchObject({ revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect(await catalog.get(siblingFolder.id)).toMatchObject({ revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect(await catalog.get(otherNamespace.id)).toMatchObject({ revision: 0, incarnation: oldIdentity });
    if (descendant) expect(await catalog.get(descendant.id)).toMatchObject({ revision: 3, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().orderBy("id").execute()).toEqual(beforeScopes);
  });
  it.each(["inspect", "confirm"] as const)("rechecks standalone ancestor binding after namespace admission for %s", async (action) => {
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "tree", incarnation: oldIdentity });
    const root = await catalog.register({ ownerId, projectId: null, kind: "file", path: "tree/root", incarnation: oldIdentity });
    identity.set("tree", currentIdentity); resourceId = parent.id; scopeId = randomUUID(); await scope(scopeId, root.id, "file");
    const admit = catalog.lockNamespace.bind(catalog);
    const gate = vi.spyOn(catalog, "lockNamespace").mockImplementationOnce(async (executor, namespace, mode) => {
      await admit(executor, namespace, mode);
      // Deterministic call-through seam: model a path change committed while
      // this request was waiting for namespace admission, without timer races.
      await catalog.bump(executor, { id: root.id, expectedRevision: 0, path: "elsewhere/root" });
    });
    const body = action === "inspect" ? { ...request(), kind: "folder" } : { ...confirmation(), kind: "folder" };
    expect((await call(action, body)).status).toBe(404);
    gate.mockRestore();
    expect((await catalog.get(parent.id))?.incarnation).toBe(oldIdentity);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("supports the existing 4096-character path contract beyond 128 catalog ancestors", async () => {
    const path = "a/".repeat(2047) + "bb"; expect(path).toHaveLength(4096);
    const deep = await catalog.register({ ownerId, projectId: null, kind: "file", path, incarnation: oldIdentity });
    identity.set(path, currentIdentity); resourceId = deep.id; scopeId = randomUUID(); await scope(scopeId, resourceId, "file");
    expect((await call("inspect", request())).status).toBe(200);
    expect((await call("confirm", confirmation())).status).toBe(200);
    expect(await catalog.get(deep.id)).toMatchObject({ id: deep.id, revision: 1, incarnation: currentIdentity });
  });
  it("invalidates only file/folder descendants in place when their owner reauthorizes a folder", async () => {
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "parent", incarnation: oldIdentity });
    const child = await catalog.register({ ownerId, projectId: null, kind: "file", path: "parent/child", incarnation: oldIdentity });
    const nested = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "parent/nested", incarnation: oldIdentity });
    const appEntry = await catalog.register({ ownerId, projectId: null, kind: "app", path: "parent/app", incarnation: oldIdentity });
    const outside = await catalog.register({ ownerId, projectId: null, kind: "file", path: "parent2/sibling", incarnation: oldIdentity });
    identity.set("parent", currentIdentity); resourceId = parent.id; scopeId = randomUUID(); await scope(scopeId, resourceId, "folder");
    const response = await call("confirm", { ...confirmation(), kind: "folder" }); expect(response.status).toBe(200);
    for (const row of [child, nested]) expect(await catalog.get(row.id)).toMatchObject({ id: row.id, revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION, deletedAt: null });
    expect(await catalog.get(appEntry.id)).toMatchObject({ revision: 0, incarnation: oldIdentity });
    expect(await catalog.get(outside.id)).toMatchObject({ revision: 0, incarnation: oldIdentity });
  });
  it("retains the direct owner session generation fence and denies stale runtime authority", async () => {
    const authenticate = vi.fn(async () => ({ actorId: ownerId, organizationId: org, authorityGeneration: 2 }));
    app = createCollaborationRoutes({ runtimeId, verifier: new CollaborationActorProofVerifier({ runtimeId, keys: { reauth: key } }),
      ownerRuntimeSessions: { authenticate }, resources: { catalog, driver: { inspect } },
    } as unknown as CollaborationRouteOptions);
    const response = await app.request(`/api/collaboration/runtimes/${runtimeId}/catalog/${resourceId}/reauthorization/confirm`, {
      method: "POST", headers: { "content-type": "application/json", "x-matrix-collaboration-session": randomUUID(),
        "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature: {}, proof: "x".repeat(43) })).toString("base64url") },
      body: JSON.stringify(confirmation()),
    });
    expect(authenticate).toHaveBeenCalledOnce(); expect(response.status).toBe(409);
    expect(inspect).not.toHaveBeenCalled(); expect((await catalog.get(resourceId))?.incarnation).toBe(oldIdentity);
  });
  it("preserves already-current folder children and requires explicit recovery for invalidated descendants", async () => {
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "parent", incarnation: oldIdentity });
    const child = await catalog.register({ ownerId, projectId: null, kind: "file", path: "parent/child", incarnation: oldIdentity });
    const childScope = randomUUID(); await scope(childScope, child.id, "file");
    identity.set("parent", currentIdentity); identity.set("parent/child", "c".repeat(64));
    resourceId = parent.id; scopeId = randomUUID(); await scope(scopeId, resourceId, "folder");
    expect((await call("confirm", { ...confirmation(), kind: "folder" })).status).toBe(200);
    expect((await call("confirm", { ...confirmation(), kind: "folder", expectedRevision: "1" })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    resourceId = child.id; scopeId = childScope;
    expect((await call("confirm", { ...confirmation(), expectedRevision: "1", currentIncarnation: "c".repeat(64) })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ id: child.id, revision: 2, incarnation: "c".repeat(64) });
  });
  it("keeps namespace matching literal for wildcard characters when invalidating folder descendants", async () => {
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "a_%", incarnation: oldIdentity });
    const child = await catalog.register({ ownerId, projectId: null, kind: "file", path: "a_%/child", incarnation: oldIdentity });
    const outside = await catalog.register({ ownerId, projectId: null, kind: "file", path: "abc/child", incarnation: oldIdentity });
    identity.set("a_%", currentIdentity); resourceId = parent.id; scopeId = randomUUID(); await scope(scopeId, resourceId, "folder");
    expect((await call("confirm", { ...confirmation(), kind: "folder" })).status).toBe(200);
    expect(await catalog.get(child.id)).toMatchObject({ revision: 1, incarnation: COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION });
    expect(await catalog.get(outside.id)).toMatchObject({ revision: 0, incarnation: oldIdentity });
  });

  it("recovers descendants using their existing folder scope without creating per-child scopes", async () => {
    const parent = await catalog.register({ ownerId, projectId: null, kind: "folder", path: "parent", incarnation: oldIdentity });
    const child = await catalog.register({ ownerId, projectId: null, kind: "file", path: "parent/child", incarnation: oldIdentity });
    const outside = await catalog.register({ ownerId, projectId: null, kind: "file", path: "outside", incarnation: oldIdentity });
    identity.set("parent", currentIdentity); identity.set("parent/child", "c".repeat(64));
    scopeId = randomUUID(); await scope(scopeId, parent.id, "folder"); resourceId = parent.id;
    expect((await call("confirm", { ...confirmation(), kind: "folder" })).status).toBe(200);
    resourceId = child.id;
    expect((await call("inspect", request())).status).toBe(200);
    expect((await call("confirm", { ...confirmation(), expectedRevision: "1", currentIncarnation: "c".repeat(64) })).status).toBe(200);
    expect((await call("confirm", confirmation(), { resource: outside.id })).status).toBe(404);
    expect(await fixture.db.selectFrom("collaboration_scopes").select("id").execute()).toHaveLength(2);
  });
  it("recovers only existing file/folder catalog members of an owned project scope", async () => {
    const child = await catalog.register({ ownerId, projectId: "project_existing", kind: "file", path: "note", incarnation: oldIdentity });
    identity.set("note", currentIdentity); resourceId = child.id; scopeId = randomUUID();
    await scope(scopeId, "project_existing", "project");
    const before = await fixture.db.selectFrom("collaboration_scopes").selectAll().execute();
    expect((await call("inspect", request())).status).toBe(200);
    expect((await call("confirm", { ...confirmation(), projectId: "project_existing" })).status).toBe(200);
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().execute()).toEqual(before);
    const other = await catalog.register({ ownerId, projectId: "project_other", kind: "file", path: "note", incarnation: oldIdentity });
    expect((await call("inspect", request(), { resource: other.id })).status).toBe(404);
  });

  it("rejects stale scope ownership, runtime, lifecycle and owner membership before physical inspection", async () => {
    const original = await fixture.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", scopeId).executeTakeFirstOrThrow();
    const parentScope = randomUUID(); await scope(parentScope, "project_parent", "project");
    for (const patch of [{ owner_id: "user_other" }, { owner_type: "organization" as const }, { authority_runtime_id: "runtime_other" },
      { lifecycle: "archived" as const }, { membership_mode: "inherited" as const, parent_scope_id: parentScope }, { deleted_at: new Date() }]) {
      await fixture.db.updateTable("collaboration_scopes").set(patch).where("id", "=", scopeId).execute();
      expect((await call("confirm", confirmation())).status).toBe(404);
      await fixture.db.updateTable("collaboration_scopes").set(original).where("id", "=", scopeId).execute();
    }
    await fixture.db.updateTable("collaboration_members").set({ role: "editor" }).where("scope_id", "=", scopeId).where("actor_id", "=", ownerId).execute();
    expect((await call("inspect", request())).status).toBe(403);
    expect(inspect).not.toHaveBeenCalled(); expect((await catalog.get(resourceId))?.incarnation).toBe(oldIdentity);
  });
  it("refuses malformed or reserved physical-provider output without replacing legacy identity", async () => {
    for (const incarnation of ["legacy", COLLABORATION_REAUTHORIZATION_REQUIRED_INCARNATION]) {
      inspect.mockResolvedValueOnce({ incarnation });
      expect((await call("inspect", request())).status).toBe(503);
      expect((await catalog.get(resourceId))?.incarnation).toBe(oldIdentity);
    }
  });

});
