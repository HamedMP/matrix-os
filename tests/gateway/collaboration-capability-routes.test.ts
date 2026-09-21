import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationGrantSchema, CollaborationReadinessSchema } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import { createOwnerResourceDriver } from "../../packages/gateway/src/collaboration/owner-resource-driver.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_capability_owner";
const memberId = "user_capability_member";
const outsiderId = "user_capability_outsider";
const organizationId = "org_capability_routes";
const scopeId = "10000000-0000-4000-8000-00000000a915";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const key = "a".repeat(32);

const socketUpgrade = (() => (_context: Context) => new Response(null, { status: 426 })) as unknown as UpgradeWebSocket;

describe("collaboration capability HTTP routes", () => {
  let fixture: CollaborationTestDatabase;
  let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>>;
  let app: Hono;
  let signer: CollaborationProofSigner;
  let homePath: string;
  let projectRoot: string;
  let appRoot: string;
  let appRegistration: string;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    runtime = await createGatewayCollaboration({
      organizationMembershipSource: {
        async assertMembership({ actorId, organizationId: requested }) {
          return requested === organizationId && actorId !== outsiderId
            ? { member: true, expiresAt: new Date(Date.now() + 20_000).toISOString(), membershipEpoch: "1", aiSubmission: "owner_only" as const }
            : { member: false };
        },
      },
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId,
        ownerId,
        activeKeyId: "key-1",
        proofKeys: { "key-1": key },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const now = new Date().toISOString();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
      kind: "project", resource_id: "project_capability", parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
      revision: 1, auth_epoch: 1, authority_runtime_id: runtimeId, authority_generation: 1,
      execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: ownerId, role: "owner", status: "accepted", organization_id: organizationId,
      invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
      joined_at: now, updated_at: now, dispositioned_at: null,
    }).execute();
    homePath = await mkdtemp(join(tmpdir(), "collaboration-owner-catalog-"));
    projectRoot = join(homePath, "projects", "demo");
    appRoot = join(homePath, "apps", "board");
    appRegistration = "a".repeat(64);
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(appRoot, { recursive: true })]);
    await writeFile(join(homePath, "notes.txt"), "one");
    runtime.enableSharedResources({ resolveAppIncarnation: async ({ ownerId: requestedOwner, projectId, appId }) =>
      requestedOwner === ownerId && projectId === null && appId === "board" ? appRegistration : null,
      driver: createOwnerResourceDriver({
      homePath,
      listOwnedProjectIds: async () => ["proj_demo"],
      resolveProjectWorkingDirectory: async (_ownerId, projectId) => projectId === "proj_demo" ? projectRoot : null,
      resolveAppAssetRoot: async (_ownerId, projectId, appId) => projectId === null && appId === "board" ? appRoot : null,
    }) });
    signer = new CollaborationProofSigner({
      activeKeyId: "key-1", keys: { "key-1": key }, now: () => new Date(), createNonce: () => randomUUID().replaceAll("-", ""),
    });
    app = new Hono();
    runtime.register({ app, upgradeWebSocket: socketUpgrade });
  });

  afterEach(async () => {
    await runtime.shutdown();
    await fixture.destroy();
    await rm(homePath, { recursive: true, force: true });
  });

  async function signed(input: { actorId: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown; scopeId?: string | null; deleteConditions?: { clientRequestId: string; expectedRevision: string; expectedMemberRevision: string } }): Promise<Response> {
    const bytes = input.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(input.body));
    const proof = signer.signHttp({
      actorId: input.actorId, ownerId, runtimeId,
      ...(input.scopeId === null ? {} : { scopeId: input.scopeId ?? scopeId }),
      method: input.method, path: input.path, query: "", body: bytes,
      ...(input.deleteConditions ? { conditionalHeaders: input.deleteConditions } : {}),
    });
    return app.request(input.path, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
        ...(input.deleteConditions ? {
          "x-matrix-client-request-id": input.deleteConditions.clientRequestId,
          "x-matrix-expected-revision": input.deleteConditions.expectedRevision,
          "x-matrix-expected-member-revision": input.deleteConditions.expectedMemberRevision,
        } : {}),
      },
      ...(input.body === undefined ? {} : { body: new TextDecoder().decode(bytes) }),
    });
  }

  it("creates a preset grant through the owner route and lists the exact contract projection", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/grants`;
    const response = await signed({ actorId: ownerId, method: "POST", path, body: {
      clientRequestId: randomUUID(), expectedRevision: "1",
      audience: { kind: "member", actorId: memberId }, preset: "viewer",
    } });
    expect(response.status).toBe(201);
    const created = CollaborationGrantSchema.parse(await response.json());
    expect(created).toMatchObject({ scopeId, organizationId, audience: { kind: "member", actorId: memberId }, preset: "viewer", state: "pending" });
    const listed = await signed({ actorId: ownerId, method: "GET", path });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([created]);
    expect((await signed({ actorId: outsiderId, method: "GET", path })).status).toBe(404);
  });

  it("patches and revokes an owner grant with expected scope and grant revisions", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/grants`;
    const createdResponse = await signed({ actorId: ownerId, method: "POST", path, body: {
      clientRequestId: randomUUID(), expectedRevision: "1",
      audience: { kind: "member", actorId: memberId }, preset: "viewer",
    } });
    expect(createdResponse.status).toBe(201);
    const created = CollaborationGrantSchema.parse(await createdResponse.json());
    const grantPath = `${path}/${created.id}`;
    const patchedResponse = await signed({ actorId: ownerId, method: "PATCH", path: grantPath, body: {
      clientRequestId: randomUUID(), expectedRevision: "2", expectedGrantRevision: "1", preset: "contributor",
    } });
    expect(patchedResponse.status).toBe(200);
    const patched = CollaborationGrantSchema.parse(await patchedResponse.json());
    expect(patched).toMatchObject({ id: created.id, preset: "contributor", revision: "2" });
    const revokedResponse = await signed({ actorId: ownerId, method: "DELETE", path: grantPath,
      deleteConditions: { clientRequestId: randomUUID(), expectedRevision: "3", expectedMemberRevision: "2" },
    });
    expect(revokedResponse.status).toBe(200);
    const revoked = CollaborationGrantSchema.parse(await revokedResponse.json());
    expect(revoked).toMatchObject({ id: created.id, state: "revoked", revision: "3" });
    expect((await signed({ actorId: ownerId, method: "GET", path })).status).toBe(200);
  });

  it("rejects legacy actor proof alone for pending organization grant acceptance", async () => {
    const created = await signed({ actorId: ownerId, method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/grants`, body: {
        clientRequestId: randomUUID(), expectedRevision: "1",
        audience: { kind: "organization" }, preset: "viewer",
      },
    });
    expect(created.status).toBe(201);
    const grant = CollaborationGrantSchema.parse(await created.json());
    const path = `/api/collaboration/scopes/${scopeId}/grants/${grant.id}/accept`;
    expect((await signed({ actorId: memberId, method: "POST", path, body: {} })).status).toBe(401);
    expect(await fixture.db.selectFrom("collaboration_grant_activations").select("grant_id")
      .where("grant_id", "=", grant.id).execute()).toEqual([]);
  });

  it("accepts the exact organization grant using a pending direct session without legacy actor proof", async () => {
    const created = await signed({ actorId: ownerId, method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/grants`, body: {
        clientRequestId: randomUUID(), expectedRevision: "1",
        audience: { kind: "organization" }, preset: "viewer",
      },
    });
    const grant = CollaborationGrantSchema.parse(await created.json());
    const path = `/api/collaboration/scopes/${scopeId}/grants/${grant.id}/accept`;
    const sessionId = randomUUID();
    const directSession = {
      protocolVersion: 2, id: sessionId, actorId: memberId, organizationId,
      scopeId, pendingGrantId: grant.id, runtimeId,
      authorityGeneration: 1, purpose: "direct_session", proofKeyThumbprint: "a".repeat(43),
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
      evidenceExpiresAt: new Date(Date.now() + 20_000).toISOString(), renewAfter: new Date(Date.now() + 240_000).toISOString(),
    } as const;
    const authenticate = vi.spyOn(runtime.directSessions, "authenticate").mockResolvedValue(directSession);
    const headers = {
      "content-type": "application/json",
      "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature: {}, proof: "a".repeat(86) })).toString("base64url"),
    };
    const wrong = await app.request(`/api/collaboration/scopes/${scopeId}/grants/${randomUUID()}/accept`, { method: "POST", headers, body: "{}" });
    expect(wrong.status).toBe(404);
    authenticate.mockResolvedValueOnce({ ...directSession, pendingGrantId: randomUUID() });
    const mismatched = await app.request(path, { method: "POST", headers, body: "{}" });
    expect(mismatched.status).toBe(404);
    const accepted = await app.request(path, { method: "POST", headers, body: "{}" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ state: "active" });
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path, body: new TextEncoder().encode("{}") }));
  });


  it("returns a bounded server-derived readiness preflight only after scope authorization", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/policy/preflight`;
    const ownerResponse = await signed({ actorId: ownerId, method: "POST", path, body: {} });
    expect(ownerResponse.status).toBe(200);
    const readiness = CollaborationReadinessSchema.parse(await ownerResponse.json());
    expect(readiness).toMatchObject({ resourceKind: "project", state: "unsupported", missingOwnerSetup: [] });
    expect(readiness.items).toHaveLength(4);
    const outsiderResponse = await signed({ actorId: outsiderId, method: "POST", path, body: {} });
    expect(outsiderResponse.status).toBe(404);
  });


  it("resolves the exact owner file to one catalog id and rotates identity when its incarnation changes", async () => {
    const path = `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`;
    const resolve = () => signed({ actorId: ownerId, method: "POST", path, scopeId: null,
      body: { kind: "file", path: "notes.txt" },
    });
    const first = await resolve();
    expect(first.status).toBe(200);
    const firstEntry = await first.json() as { id: string; kind: string; path: string; incarnation: string; revision: string };
    expect(firstEntry).toMatchObject({ kind: "file", path: "notes.txt", revision: "0" });
    const second = await resolve();
    expect(second.status).toBe(200);
    expect((await second.json() as { id: string }).id).toBe(firstEntry.id);
    await rm(join(homePath, "notes.txt"));
    await writeFile(join(homePath, "notes.txt"), "different bytes");
    const replaced = await resolve();
    expect(replaced.status).toBe(200);
    expect((await replaced.json() as { id: string }).id).not.toBe(firstEntry.id);
    const outsider = await signed({ actorId: outsiderId, method: "POST", path, scopeId: null,
      body: { kind: "file", path: "notes.txt" },
    });
    expect(outsider.status).toBe(403);
  });

  it("routes encoded vps owner catalog requests through only the bounded owner runtime session", async () => {
    const sessions = runtime.ownerRuntimeSessions;
    expect(sessions).toBeDefined();
    const sessionId = randomUUID();
    const authenticate = vi.spyOn(sessions!, "authenticate").mockResolvedValue({
      protocolVersion: 2, id: sessionId, actorId: ownerId, organizationId,
      runtimeId: runtimeId.replace(":", "-"), authorityGeneration: 1, purpose: "owner_runtime",
      proofKeyThumbprint: "a".repeat(43), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(), evidenceExpiresAt: new Date(Date.now() + 20_000).toISOString(),
      renewAfter: new Date(Date.now() + 240_000).toISOString(),
    });
    const path = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/catalog/resolve`;
    const headers = {
      "content-type": "application/json", "x-matrix-collaboration-session": sessionId,
      "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature: {}, proof: "a".repeat(86) })).toString("base64url"),
    };
    const body = JSON.stringify({ kind: "file", path: "notes.txt", organizationId });
    const response = await app.request(path, { method: "POST", headers, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "file", path: "notes.txt" });
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path, body: new TextEncoder().encode(body) }));
    authenticate.mockResolvedValueOnce({
      protocolVersion: 2, id: sessionId, actorId: ownerId, organizationId: "org_wrong",
      runtimeId: runtimeId.replace(":", "-"), authorityGeneration: 1, purpose: "owner_runtime",
      proofKeyThumbprint: "a".repeat(43), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(), evidenceExpiresAt: new Date(Date.now() + 20_000).toISOString(),
      renewAfter: new Date(Date.now() + 240_000).toISOString(),
    });
    expect((await app.request(path, { method: "POST", headers, body })).status).toBe(403);
  });

  it("requires an exact catalog UUID on the encoded owner-runtime preflight and create routes", async () => {
    const catalog = await signed({ actorId: ownerId, method: "POST",
      path: `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`, scopeId: null,
      body: { kind: "file", path: "notes.txt", organizationId },
    });
    expect(catalog.status).toBe(200);
    const entry = await catalog.json() as { id: string };
    const authenticate = vi.spyOn(runtime.ownerRuntimeSessions!, "authenticate").mockResolvedValue({
      protocolVersion: 2, id: randomUUID(), actorId: ownerId, organizationId,
      runtimeId: runtimeId.replace(":", "-"), authorityGeneration: 1, purpose: "owner_runtime",
      proofKeyThumbprint: "a".repeat(43), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(), evidenceExpiresAt: new Date(Date.now() + 20_000).toISOString(),
      renewAfter: new Date(Date.now() + 240_000).toISOString(),
    });
    const headers = { "content-type": "application/json", "x-matrix-collaboration-session": randomUUID(),
      "x-matrix-collaboration-request": Buffer.from(JSON.stringify({ signature: {}, proof: "a".repeat(86) })).toString("base64url") };
    const prefix = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
    const invalid = await app.request(`${prefix}/scopes/preflight`, { method: "POST", headers,
      body: JSON.stringify({ kind: "file", resourceId: "notes.txt", organizationId }) });
    expect(invalid.status).toBe(400);
    const preflight = await app.request(`${prefix}/scopes/preflight`, { method: "POST", headers,
      body: JSON.stringify({ kind: "file", resourceId: entry.id, organizationId }) });
    expect(preflight.status).toBe(200);
    const preview = await preflight.json() as { resourceRevision: string; confirmationToken: string };
    const created = await app.request(`${prefix}/scopes`, { method: "POST", headers,
      body: JSON.stringify({ kind: "file", resourceId: entry.id, organizationId,
        clientRequestId: randomUUID(), expectedRevision: preview.resourceRevision,
        confirmationToken: preview.confirmationToken }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ resourceId: entry.id, lifecycle: "shared" });
    expect(authenticate).toHaveBeenCalledTimes(3);
  });

  it("derives the project namespace for a selected owner file and rejects an enclosing folder", async () => {
    await writeFile(join(projectRoot, "source.ts"), "export const value = 1;");
    const route = `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`;
    const resolved = await signed({ actorId: ownerId, method: "POST", path: route, scopeId: null,
      body: { kind: "file", path: "projects/demo/source.ts" },
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ kind: "file", path: "projects/demo/source.ts" });
    const projectEntry = await fixture.db.selectFrom("collaboration_resource_catalog").selectAll()
      .where("owner_id", "=", ownerId).where("project_id", "=", "proj_demo")
      .where("kind", "=", "file").where("path", "=", "source.ts").where("deleted_at", "is", null)
      .executeTakeFirst();
    expect(projectEntry?.id).toBeDefined();
    expect(await fixture.db.selectFrom("collaboration_resource_catalog").select("id")
      .where("owner_id", "=", ownerId).where("project_id", "is", null)
      .where("kind", "=", "file").where("path", "=", "projects/demo/source.ts")
      .where("deleted_at", "is", null).executeTakeFirst()).toBeUndefined();
    expect((await signed({ actorId: ownerId, method: "POST", path: route, scopeId: null,
      body: { kind: "folder", path: "projects" },
    })).status).toBe(403);
  });

  it("resolves exact standalone folder and registered app identities", async () => {
    const path = `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`;
    for (const [kind, resourcePath] of [["folder", "apps"], ["app", "board"]] as const) {
      const response = await signed({ actorId: ownerId, method: "POST", path, scopeId: null,
        body: { kind, path: resourcePath },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ kind, path: resourcePath });
    }
    expect((await signed({ actorId: ownerId, method: "POST", path, scopeId: null,
      body: { kind: "app", path: "unknown" },
    })).status).toBe(404);
  });

  it("preflights and shares only the exact catalog-bound standalone file", async () => {
    const catalogPath = `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`;
    const catalog = await signed({ actorId: ownerId, method: "POST", path: catalogPath, scopeId: null,
      body: { kind: "file", path: "notes.txt", organizationId },
    });
    expect(catalog.status).toBe(200);
    const entry = await catalog.json() as { id: string; revision: string };
    const preflightPath = `/api/collaboration/runtimes/${runtimeId}/scopes/preflight`;
    const preflight = await signed({ actorId: ownerId, method: "POST", path: preflightPath, scopeId: null,
      body: { kind: "file", resourceId: entry.id, organizationId },
    });
    expect(preflight.status).toBe(200);
    const preview = await preflight.json() as { eligible: boolean; resourceRevision: string; confirmationToken: string };
    expect(preview).toMatchObject({ eligible: true, resourceRevision: entry.revision });
    const createPath = `/api/collaboration/runtimes/${runtimeId}/scopes`;
    const body = { kind: "file", resourceId: entry.id, organizationId, clientRequestId: randomUUID(),
      expectedRevision: preview.resourceRevision, confirmationToken: preview.confirmationToken };
    const created = await signed({ actorId: ownerId, method: "POST", path: createPath, scopeId: null, body });
    expect(created.status).toBe(201);
    const scope = await created.json() as { id: string; kind: string; resourceId: string; lifecycle: string };
    expect(scope).toMatchObject({ kind: "file", resourceId: entry.id, lifecycle: "shared" });
    const replay = await signed({ actorId: ownerId, method: "POST", path: createPath, scopeId: null, body });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string }).id).toBe(scope.id);
    expect(await fixture.db.selectFrom("collaboration_events").select("event_id")
      .where("scope_id", "=", scope.id).execute()).toHaveLength(1);
  });

  it("shares standalone folders and apps by catalog identity, then rejects a replaced app registration", async () => {
    const catalogPath = `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`;
    const preflightPath = `/api/collaboration/runtimes/${runtimeId}/scopes/preflight`;
    const createPath = `/api/collaboration/runtimes/${runtimeId}/scopes`;
    for (const [kind, resourcePath] of [["folder", "apps"], ["app", "board"]] as const) {
      const resolved = await signed({ actorId: ownerId, method: "POST", path: catalogPath, scopeId: null,
        body: { kind, path: resourcePath, organizationId },
      });
      expect(resolved.status, await resolved.clone().text()).toBe(200);
      const entry = await resolved.json() as { id: string; incarnation: string };
      const preflight = await signed({ actorId: ownerId, method: "POST", path: preflightPath, scopeId: null,
        body: { kind, resourceId: entry.id, organizationId },
      });
      expect(preflight.status).toBe(200);
      const preview = await preflight.json() as { resourceRevision: string; confirmationToken: string };
      if (kind === "app") {
        appRegistration = "b".repeat(64);
        expect((await signed({ actorId: ownerId, method: "POST", path: createPath, scopeId: null,
          body: { kind, resourceId: entry.id, organizationId, clientRequestId: randomUUID(),
            expectedRevision: preview.resourceRevision, confirmationToken: preview.confirmationToken },
        })).status).toBe(409);
        const rotated = await signed({ actorId: ownerId, method: "POST", path: catalogPath, scopeId: null,
          body: { kind, path: resourcePath, organizationId },
        });
        expect(rotated.status).toBe(200);
        const newEntry = await rotated.json() as { id: string; incarnation: string };
        expect(newEntry.id).not.toBe(entry.id);
        expect(newEntry.incarnation).toBe(appRegistration);
        expect((await signed({ actorId: ownerId, method: "POST", path: preflightPath, scopeId: null,
          body: { kind, resourceId: entry.id, organizationId },
        })).status).toBe(404);
        const refreshed = await signed({ actorId: ownerId, method: "POST", path: preflightPath, scopeId: null,
          body: { kind, resourceId: newEntry.id, organizationId },
        });
        expect(refreshed.status).toBe(200);
        const currentPreview = await refreshed.json() as { resourceRevision: string; confirmationToken: string };
        const shared = await signed({ actorId: ownerId, method: "POST", path: createPath, scopeId: null,
          body: { kind, resourceId: newEntry.id, organizationId, clientRequestId: randomUUID(),
            expectedRevision: currentPreview.resourceRevision, confirmationToken: currentPreview.confirmationToken },
        });
        expect(shared.status).toBe(201);
        expect(await shared.json()).toMatchObject({ kind, resourceId: newEntry.id, lifecycle: "shared" });
        continue;
      }
      const created = await signed({ actorId: ownerId, method: "POST", path: createPath, scopeId: null,
        body: { kind, resourceId: entry.id, organizationId, clientRequestId: randomUUID(),
          expectedRevision: preview.resourceRevision, confirmationToken: preview.confirmationToken },
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ kind, resourceId: entry.id, lifecycle: "shared" });
    }
    expect((await signed({ actorId: ownerId, method: "POST", path: preflightPath, scopeId: null,
      body: { kind: "app", resourceId: "board", organizationId },
    })).status).toBe(400);
  });

});
