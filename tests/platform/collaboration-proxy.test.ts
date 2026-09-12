import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  CollaborationProxy,
  collaborationMilestoneForRoute,
  parseCollaborationProxyRoute,
} from "../../packages/platform/src/collaboration/proxy.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";

describe("CollaborationProxy", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let proxy: CollaborationProxy;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{
        actorId: platformCollaborationActors.recipientWithoutComputer,
        status: "invited",
        invitationId,
      }],
    });
    await repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "internal",
      cohort: [platformCollaborationActors.owner, platformCollaborationActors.recipientWithoutComputer],
      changedBy: "operator_test",
    });
    fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    proxy = new CollaborationProxy({
      repository,
      signer: new CollaborationProofSigner({
        activeKeyId: "collaboration-key-1",
        keys: { "collaboration-key-1": key },
        now: () => now,
        createNonce: () => "a".repeat(32),
      }),
      resolveRuntime: async (runtimeId) => runtimeId === "runtime_owner"
        ? { runtimeId, ownerId: platformCollaborationActors.owner, baseUrl: "https://owner-runtime.internal" }
        : null,
      fetchImpl,
      now: () => now,
    });
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("routes an invited actor without a computer and strips owner credentials", async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      clientRequestId: "40000000-0000-4000-8000-000000000001",
      expectedRevision: "1",
    }));
    const response = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "POST",
      path: `/api/collaboration/invitations/${invitationId}/accept`,
      query: "",
      body,
      headers: new Headers({
        authorization: "Bearer caller-session",
        cookie: "owner=secret",
        "x-matrix-owner-token": "must-not-forward",
        "x-matrix-collaboration-proof": "caller-injected",
        "content-type": "application/json",
      }),
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://owner-runtime.internal/api/collaboration/invitations/${invitationId}/accept`);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-matrix-owner-token")).toBe(false);
    expect(headers.get("x-matrix-collaboration-proof")).not.toBe("caller-injected");

    const signedProof = JSON.parse(Buffer.from(
      headers.get("x-matrix-collaboration-proof")!,
      "base64url",
    ).toString("utf8"));
    const verifier = new CollaborationActorProofVerifier({
      runtimeId: "runtime_owner",
      keys: { "collaboration-key-1": key },
      now: () => now,
    });
    await expect(verifier.verifyHttp({
      signedProof,
      method: "POST",
      path: `/api/collaboration/invitations/${invitationId}/accept`,
      query: "",
      body,
    })).resolves.toMatchObject({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      ownerId: platformCollaborationActors.owner,
      scopeId,
    });
  });

  it("routes owner-only Chat sharing creation to the selected registered runtime", async () => {
    const path = "/api/collaboration/runtimes/runtime_owner/scopes/preflight";
    expect(parseCollaborationProxyRoute("POST", path)).toEqual({ kind: "runtime", identifier: "runtime_owner" });
    const denied = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "POST",
      path,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });
    expect(denied.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();

    const response = await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "POST",
      path,
      query: "",
      body: new Uint8Array(),
      headers: new Headers({ "content-type": "application/json" }),
    });
    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const signedProof = JSON.parse(Buffer.from(
      new Headers(init.headers).get("x-matrix-collaboration-proof")!,
      "base64url",
    ).toString("utf8"));
    expect(signedProof.proof).toMatchObject({
      actorId: platformCollaborationActors.owner,
      ownerId: platformCollaborationActors.owner,
      runtimeId: "runtime_owner",
    });
    expect(signedProof.proof.scopeId).toBeUndefined();
  });

  it("routes only the exact owner lifecycle, operation, and export paths", () => {
    const operationId = "50000000-0000-4000-8000-000000000001";
    expect(parseCollaborationProxyRoute("POST", `/api/collaboration/scopes/${scopeId}/lifecycle`))
      .toEqual({ kind: "scope", identifier: scopeId });
    expect(parseCollaborationProxyRoute("GET", `/api/collaboration/scopes/${scopeId}/operations/${operationId}`))
      .toEqual({ kind: "scope", identifier: scopeId });
    expect(parseCollaborationProxyRoute("GET", `/api/collaboration/scopes/${scopeId}/exports/${operationId}`))
      .toEqual({ kind: "scope", identifier: scopeId });
    expect(parseCollaborationProxyRoute("GET", `/api/collaboration/scopes/${scopeId}/exports/${operationId}/raw`))
      .toBeNull();
  });

  it("classifies shared AI routes under M2 without moving discussion off M1", () => {
    const requestId = "qturn_shared_request_1";
    const approvalId = "approval_shared_request_1";
    expect(collaborationMilestoneForRoute("GET", `/api/collaboration/scopes/${scopeId}/chat/messages`))
      .toBe("m1");
    expect(collaborationMilestoneForRoute("GET", `/api/collaboration/scopes/${scopeId}/chat/requests`))
      .toBe("m2");
    expect(collaborationMilestoneForRoute("POST", `/api/collaboration/scopes/${scopeId}/chat/requests`))
      .toBe("m2");
    expect(collaborationMilestoneForRoute(
      "POST",
      `/api/collaboration/scopes/${scopeId}/chat/requests/${requestId}/cancel`,
    )).toBe("m2");
    expect(collaborationMilestoneForRoute(
      "POST",
      `/api/collaboration/scopes/${scopeId}/chat/requests/${requestId}/retry`,
    )).toBe("m2");
    expect(collaborationMilestoneForRoute(
      "POST",
      `/api/collaboration/scopes/${scopeId}/chat/approvals/${approvalId}/decision`,
    )).toBe("m2");
  });

  it("keeps M2 AI routes disabled independently from M1 discussion", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/chat/requests`;
    const body = new TextEncoder().encode(JSON.stringify({
      clientRequestId: "40000000-0000-4000-8000-000000000011",
      expectedRevision: "1",
      text: "Summarize our discussion",
    }));
    const disabled = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "POST",
      path,
      query: "",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
    expect(disabled.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();

    await repository.setPolicy({
      milestone: "m2",
      expectedRevision: 0,
      mode: "internal",
      cohort: [platformCollaborationActors.owner, platformCollaborationActors.recipientWithoutComputer],
      changedBy: "operator_test",
    });
    const enabled = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "POST",
      path,
      query: "",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
    expect(enabled.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const policyHeader = new Headers(init.headers).get("x-matrix-collaboration-policy");
    expect(policyHeader).toMatch(/^[A-Za-z0-9_-]+$/);
    const verifier = new CollaborationActorProofVerifier({
      runtimeId: "runtime_owner", keys: { "collaboration-key-1": key }, now: () => now,
    });
    expect(verifier.verifyPolicy(JSON.parse(Buffer.from(policyHeader!, "base64url").toString("utf8"))))
      .toMatchObject({ milestone: "m2", mode: "internal" });
  });

  it("streams a completed owner export without applying the JSON API buffer limit", async () => {
    const exportId = "50000000-0000-4000-8000-000000000002";
    const payload = JSON.stringify({ data: "x".repeat((2 * 1024 * 1024) + 1) });
    fetchImpl.mockResolvedValueOnce(new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
    }));

    const response = await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "GET",
      path: `/api/collaboration/scopes/${scopeId}/exports/${exportId}`,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(payload);
  });

  it("keeps owner lifecycle recovery available while the M1 rollout policy is off", async () => {
    await repository.setPolicy({
      milestone: "m1",
      expectedRevision: 1,
      mode: "off",
      cohort: [],
      changedBy: "operator_rollback",
    });
    const path = `/api/collaboration/scopes/${scopeId}/lifecycle`;
    const body = new TextEncoder().encode(JSON.stringify({
      type: "export",
      clientRequestId: "50000000-0000-4000-8000-000000000009",
      expectedRevision: "1",
    }));
    expect((await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "POST",
      path,
      query: "",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    })).status).toBe(200);
    expect((await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "POST",
      path,
      query: "",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    })).status).toBe(404);
  });

  it.each([
    ["GET", `/api/collaboration/scopes/${scopeId}/../../files`],
    ["POST", `/api/collaboration/scopes/${scopeId}/terminal/input`],
    ["GET", "/api/chats/private"],
    ["PUT", `/api/collaboration/scopes/${scopeId}`],
  ])("rejects route escape %s %s before resolving or fetching", async (method, path) => {
    expect(parseCollaborationProxyRoute(method, path)).toBeNull();
    const response = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method,
      path,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps directory metadata non-authoritative when the runtime denies membership", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("raw owner database detail", { status: 403 }));
    const response = await proxy.forward({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      method: "GET",
      path: `/api/collaboration/scopes/${scopeId}/chat`,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Collaboration request denied");
  });

  it("forwards only signed conditional headers on body-free DELETE", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/members/${platformCollaborationActors.recipientWithoutComputer}`;
    const conditions = {
      "x-matrix-client-request-id": "40000000-0000-4000-8000-000000000009",
      "x-matrix-expected-revision": "3",
      "x-matrix-expected-member-revision": "2",
    };
    const response = await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "DELETE",
      path,
      query: "",
      body: new Uint8Array(),
      headers: new Headers({ ...conditions, "x-matrix-owner-token": "never-forward" }),
    });
    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const forwarded = new Headers(init.headers);
    expect(forwarded.get("x-matrix-client-request-id")).toBe(conditions["x-matrix-client-request-id"]);
    expect(forwarded.has("x-matrix-owner-token")).toBe(false);
    expect(init.body).toBeUndefined();
    const signedProof = JSON.parse(Buffer.from(forwarded.get("x-matrix-collaboration-proof")!, "base64url").toString("utf8"));
    const verifier = new CollaborationActorProofVerifier({
      runtimeId: "runtime_owner", keys: { "collaboration-key-1": key }, now: () => now,
    });
    await expect(verifier.verifyHttp({
      signedProof, method: "DELETE", path, query: "", body: new Uint8Array(),
      conditionalHeaders: {
        clientRequestId: conditions["x-matrix-client-request-id"],
        expectedRevision: conditions["x-matrix-expected-revision"],
        expectedMemberRevision: conditions["x-matrix-expected-member-revision"],
      },
    })).resolves.toMatchObject({ actorId: platformCollaborationActors.owner });
  });

  it("returns a safe unavailable response on timeout or upstream failure", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.7:443"));
    const response = await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "GET",
      path: `/api/collaboration/scopes/${scopeId}`,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Collaboration unavailable");
  });

  it("maps directory and signing dependency failures to a safe unavailable response", async () => {
    const routeSpy = vi.spyOn(repository, "getDirectoryRoute").mockRejectedValueOnce(
      new Error("postgres host and credentials must stay private"),
    );
    const response = await proxy.forward({
      actorId: platformCollaborationActors.owner,
      method: "GET",
      path: `/api/collaboration/scopes/${scopeId}`,
      query: "",
      body: new Uint8Array(),
      headers: new Headers(),
    });
    expect(routeSpy).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Collaboration unavailable");
  });
});
