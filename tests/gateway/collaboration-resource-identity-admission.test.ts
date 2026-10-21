import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import { CollaborationResourceCatalog, ResourceCatalogError } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import type { CollaborationResourceDriver } from "../../packages/gateway/src/collaboration/resource-actions.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_identity_owner", organizationId = "org_identity_admission";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111", key = "a".repeat(32);
const fileScope = "10000000-0000-4000-8000-000000000701";
const folderScope = "10000000-0000-4000-8000-000000000702";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("physical identity admission for existing resource grants", () => {
  let db: CollaborationTestDatabase;
  let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>>;
  let catalog: CollaborationResourceCatalog;
  let app: Hono, signer: CollaborationProofSigner;
  let fileId: string, folderId: string;
  let incarnations: Map<string, string>, files: Map<string, Uint8Array>;
  let driver: CollaborationResourceDriver;
  beforeEach(async () => {
    db = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(db.db);
    runtime = await createGatewayCollaboration({
      db: db.db, chatRepository: new ChatRepository(db.db), startTimers: false,
      organizationMembershipSource: { async assertMembership() {
        return { member: true, expiresAt: new Date(Date.now() + 20_000).toISOString(), membershipEpoch: "1", aiSubmission: "owner_only" as const };
      } },
      config: { runtimeId, ownerId, activeKeyId: "key-1", proofKeys: { "key-1": key }, preflightSecret: "b".repeat(32), platformBaseUrl: "https://platform.internal", serviceToken: "c".repeat(32) },
      outboxFetch: async () => new Response(null, { status: 204 }),
    });
    incarnations = new Map([["shared", "a".repeat(64)], ["shared/note.txt", "b".repeat(64)]]);
    files = new Map([["shared/note.txt", new TextEncoder().encode("original shared bytes")]]);
    driver = {
      fingerprint: vi.fn(async ({ path }) => {
        const value = incarnations.get(path);
        if (!value) throw new ResourceCatalogError("not_found");
        return value;
      }),
      read: vi.fn(async ({ path, expectedIncarnation }) => {
        if (incarnations.get(path) !== expectedIncarnation) throw new ResourceCatalogError("not_found");
        const bytes = files.get(path);
        if (!bytes) throw new ResourceCatalogError("not_found");
        return { size: bytes.byteLength, stream: new Blob([bytes]).stream() };
      }),
      write: vi.fn(async ({ path, content }) => {
        files.set(path, content); const incarnation = randomUUID(); incarnations.set(path, incarnation); return incarnation;
      }),
      writeChunks: vi.fn(async ({ path, chunks, sha256, size }) => {
        const parts = [];
        for await (const part of chunks) parts.push(part);
        const bytes = Buffer.concat(parts);
        if (bytes.length !== size || digest(bytes) !== sha256) throw new ResourceCatalogError("conflict");
        files.set(path, bytes); const incarnation = randomUUID(); incarnations.set(path, incarnation); return incarnation;
      }),
      mkdir: vi.fn(async ({ path }) => { incarnations.set(path, randomUUID()); }),
      remove: vi.fn(async ({ path }) => { files.delete(path); incarnations.delete(path); }),
      rename: vi.fn(async ({ from, to }) => {
        const bytes = files.get(from), incarnation = incarnations.get(from);
        if (bytes) files.set(to, bytes);
        if (incarnation) incarnations.set(to, incarnation);
        files.delete(from); incarnations.delete(from);
      }),
      readAppAsset: vi.fn(async () => { throw new ResourceCatalogError("not_found"); }),
    };
    runtime.enableSharedResources({ driver });
    catalog = new CollaborationResourceCatalog(db.db);
    const ns = { ownerId, projectId: null };
    folderId = (await catalog.register({ ...ns, kind: "folder", path: "shared", incarnation: incarnations.get("shared")! })).id;
    fileId = (await catalog.register({ ...ns, kind: "file", path: "shared/note.txt", incarnation: incarnations.get("shared/note.txt")! })).id;
    const now = new Date().toISOString();
    for (const [id, kind, resourceId] of [[fileScope, "file", fileId], [folderScope, "folder", folderId]] as const) {
      await db.db.insertInto("collaboration_scopes").values({
        id, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
        kind, resource_id: resourceId, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
        revision: 1, auth_epoch: 1, authority_runtime_id: runtimeId, authority_generation: 1,
        execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
      }).execute();
      await db.db.insertInto("collaboration_members").values({
        scope_id: id, actor_id: ownerId, role: "owner", status: "accepted", organization_id: organizationId,
        invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
        joined_at: now, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    signer = new CollaborationProofSigner({ activeKeyId: "key-1", keys: { "key-1": key }, now: () => new Date(), createNonce: () => randomUUID().replaceAll("-", "") });
    app = new Hono(); runtime.register({ app, upgradeWebSocket: (() => new Response(null, { status: 426 })) as never });
  });
  afterEach(async () => { await runtime?.shutdown(); await db?.destroy(); });

  async function request(scopeId: string, method: "GET" | "POST", suffix: string, body?: unknown) {
    const path = `/api/collaboration/scopes/${scopeId}/files${suffix}`;
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const proof = signer.signHttp({ actorId: ownerId, ownerId, runtimeId, scopeId, method, path, query: "", body: bytes });
    return app.request(path, { method, headers: { "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: new TextDecoder().decode(bytes) }) });
  }
  const action = (scopeId: string, body: unknown) => request(scopeId, "POST", "/actions", body);

  it.each(["write", "rename", "delete"] as const)("refuses implicit reauthorization through %s before any side effect", async type => {
    incarnations.set("shared/note.txt", "c".repeat(64));
    const body = { type, fileId, expectedRevision: "0", clientRequestId: randomUUID(), ...(type === "write" ? { content: "unauthorized overwrite" } : type === "rename" ? { path: "shared/moved.txt" } : {}) };
    expect((await action(folderScope, body)).status).toBe(404);
    expect(driver[type === "delete" ? "remove" : type]).not.toHaveBeenCalled();
    expect(await catalog.get(fileId)).toMatchObject({ revision: 0, incarnation: "b".repeat(64) });
    expect(new TextDecoder().decode(files.get("shared/note.txt"))).toBe("original shared bytes");
  });
  it.each(["", "/content"])("refuses a replaced folder root even when its leaf identity is unchanged (%s)", async suffix => {
    incarnations.set("shared", "c".repeat(64));
    const response = await request(folderScope, "GET", suffix ? `/${fileId}${suffix}` : "");
    expect(response.status).toBe(404);
    expect(driver.read).not.toHaveBeenCalled();
  });
  it("refuses creating bytes inside a replaced standalone folder", async () => {
    incarnations.set("shared", "c".repeat(64));
    expect((await action(folderScope, { type: "create", kind: "file", parentId: folderId, path: "shared/new.txt", content: "new", clientRequestId: randomUUID() })).status).toBe(404);
    expect(driver.write).not.toHaveBeenCalled();
    expect(await catalog.getLiveByPath({ ownerId, projectId: null, kind: "file", path: "shared/new.txt" })).toBeNull();
  });
  it.each(["root", "leaf"])("revalidates the %s after upload staging before committing any bytes", async changed => {
    const uploadId = randomUUID(), bytes = Buffer.from("staged replacement");
    expect((await action(folderScope, { type: "upload_stage", fileId, size: bytes.length, sha256: digest(bytes), clientRequestId: uploadId })).status).toBe(200);
    expect((await action(folderScope, { type: "upload_part", uploadId, index: 0, sha256: digest(bytes), chunk: bytes.toString("base64") })).status).toBe(200);
    incarnations.set(changed === "root" ? "shared" : "shared/note.txt", "c".repeat(64));
    expect((await action(folderScope, { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: randomUUID() })).status).toBe(404);
    expect(driver.writeChunks).not.toHaveBeenCalled();
    expect(await catalog.get(fileId)).toMatchObject({ revision: 0, incarnation: "b".repeat(64) });
    expect((await db.db.selectFrom("collaboration_upload_stages").select("state").where("id", "=", uploadId).executeTakeFirst())?.state).toBe("staging");
  });
  it("keeps authorized atomic writes and their new catalog incarnation", async () => {
    expect((await action(folderScope, { type: "write", fileId, expectedRevision: "0", content: "authorized update", clientRequestId: randomUUID() })).status).toBe(200);
    expect(await catalog.get(fileId)).toMatchObject({ revision: 1, incarnation: incarnations.get("shared/note.txt") });
    expect(await (await request(folderScope, "GET", `/${fileId}/content`)).text()).toBe("authorized update");
  });

  it.each(["read", "write"] as const)("refuses %s through a replaced intermediate folder without changing the root or leaf", async operation => {
    const ns = { ownerId, projectId: null };
    incarnations.set("shared/nested", "d".repeat(64));
    await catalog.register({ ...ns, kind: "folder", path: "shared/nested", incarnation: "d".repeat(64) });
    incarnations.set("shared/nested/child.txt", "e".repeat(64));
    files.set("shared/nested/child.txt", Buffer.from("nested original"));
    const child = await catalog.register({ ...ns, kind: "file", path: "shared/nested/child.txt", incarnation: "e".repeat(64) });
    incarnations.set("shared/nested", "f".repeat(64));
    const response = operation === "read"
      ? await request(folderScope, "GET", `/${child.id}/content`)
      : await action(folderScope, { type: "write", fileId: child.id, expectedRevision: "0", content: "denied", clientRequestId: randomUUID() });
    expect(response.status).toBe(404);
    expect(driver.read).not.toHaveBeenCalled();
    expect(driver.write).not.toHaveBeenCalled();
    expect(await catalog.get(child.id)).toMatchObject({ revision: 0, incarnation: "e".repeat(64) });
  });

  it("refuses rename into a replaced cataloged destination folder", async () => {
    incarnations.set("shared/destination", "d".repeat(64));
    await catalog.register({ ownerId, projectId: null, kind: "folder", path: "shared/destination", incarnation: "d".repeat(64) });
    incarnations.set("shared/destination", "e".repeat(64));
    expect((await action(folderScope, { type: "rename", fileId, expectedRevision: "0", path: "shared/destination/note.txt", clientRequestId: randomUUID() })).status).toBe(404);
    expect(driver.rename).not.toHaveBeenCalled();
    expect(await catalog.get(fileId)).toMatchObject({ path: "shared/note.txt", revision: 0 });
  });

  it.each([false, true])("checks higher destination ancestors when the immediate parent has no catalog row (replaced=%s)", async replaced => {
    const projectId = "project_identity", projectScope = randomUUID();
    const existingScope = await db.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", fileScope).executeTakeFirstOrThrow();
    const existingMember = await db.db.selectFrom("collaboration_members").selectAll().where("scope_id", "=", fileScope).executeTakeFirstOrThrow();
    await db.db.insertInto("collaboration_scopes").values({ ...existingScope, id: projectScope, kind: "project", resource_id: projectId }).execute();
    await db.db.insertInto("collaboration_members").values({ ...existingMember, scope_id: projectScope }).execute();
    incarnations.set("origin.txt", "c".repeat(64)); files.set("origin.txt", Buffer.from("authorized original"));
    const source = await catalog.register({ ownerId, projectId, kind: "file", path: "origin.txt", incarnation: "c".repeat(64) });
    await catalog.register({ ownerId, projectId, kind: "folder", path: "docs", incarnation: "d".repeat(64) });
    incarnations.set("docs", (replaced ? "e" : "d").repeat(64));
    incarnations.set("docs/nested", "f".repeat(64));
    expect(await catalog.getLiveByPath({ ownerId, projectId, kind: "folder", path: "docs/nested" })).toBeNull();
    const response = await action(projectScope, { type: "rename", fileId: source.id, path: "docs/nested/moved.txt", expectedRevision: "0", clientRequestId: randomUUID() });
    expect(response.status).toBe(replaced ? 404 : 200);
    if (replaced) expect(driver.rename).not.toHaveBeenCalled();
    expect(await catalog.get(source.id)).toMatchObject({ path: replaced ? "origin.txt" : "docs/nested/moved.txt", incarnation: "c".repeat(64) });
  });

  it("never rebinds a standalone file grant when a concurrent replacement wins before rename", async () => {
    const rename = driver.rename.bind(driver);
    vi.mocked(driver.rename).mockImplementationOnce(async input => {
      incarnations.set(input.from, "f".repeat(64)); files.set(input.from, Buffer.from("private concurrent replacement"));
      await rename(input);
    });
    expect((await action(folderScope, { type: "rename", fileId, path: "shared/moved.txt", expectedRevision: "0", clientRequestId: randomUUID() })).status).toBe(404);
    expect(await catalog.get(fileId)).toMatchObject({ revision: 0, path: "shared/note.txt", incarnation: "b".repeat(64) });
    expect((await request(fileScope, "GET", `/${fileId}/content`)).status).toBe(404);
  });

  it.each(["write", "upload"] as const)("does not bless an unrelated replacement after the authorized %s has finished", async operation => {
    const replacement = "f".repeat(64);
    if (operation === "write") {
      const write = driver.write.bind(driver);
      vi.mocked(driver.write).mockImplementationOnce(async input => {
        const created = await write(input); incarnations.set(input.path, replacement);
        files.set(input.path, Buffer.from("private concurrent replacement")); return created;
      });
      expect((await action(folderScope, { type: "write", fileId, expectedRevision: "0", content: "authorized", clientRequestId: randomUUID() })).status).toBe(200);
    } else {
      const write = driver.writeChunks.bind(driver);
      vi.mocked(driver.writeChunks).mockImplementationOnce(async input => {
        const created = await write(input); incarnations.set(input.path, replacement);
        files.set(input.path, Buffer.from("private concurrent replacement")); return created;
      });
      const uploadId = randomUUID(), bytes = Buffer.from("authorized");
      expect((await action(folderScope, { type: "upload_stage", fileId, size: bytes.length, sha256: digest(bytes), clientRequestId: uploadId })).status).toBe(200);
      expect((await action(folderScope, { type: "upload_part", uploadId, index: 0, sha256: digest(bytes), chunk: bytes.toString("base64") })).status).toBe(200);
      expect((await action(folderScope, { type: "upload_commit", uploadId, expectedRevision: "0", clientRequestId: randomUUID() })).status).toBe(201);
    }
    expect((await catalog.get(fileId))?.incarnation).not.toBe(replacement);
    expect((await request(fileScope, "GET", `/${fileId}/content`)).status).toBe(404);
  });
});
