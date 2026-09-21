import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyEd25519, requestSigningPayload } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";

const platform = "https://app.matrix-os.com";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const organizationId = "org_runtime_setup";
const ownerId = "user_runtime_owner";
const now = new Date("2026-09-21T12:00:00.000Z");

describe("owner runtime direct client", () => {
  it("keeps a private prepared project on the owner-runtime session through inventory and confirm", async () => {
    const scopeId = "10000000-0000-4000-8000-000000000921";
    const signedPaths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        const proofPublicKey = (JSON.parse(String(init?.body)) as { proofPublicKey: string }).proofPublicKey;
        const ticket = {
          protocolVersion: 2, ticketId: "10000000-0000-4000-8000-000000000001", nonce: "a".repeat(64),
          actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
          runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        };
        return Response.json({ signedTicket: { ticket, keyId: "platform", signature: "a".repeat(86) },
          endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      }
      if (url.pathname === "/api/collaboration/owner-runtime/sessions") {
        const proofPublicKey = (JSON.parse(String(init?.body)) as { proofPublicKey: string }).proofPublicKey;
        return Response.json({
          protocolVersion: 2, id: "20000000-0000-4000-8000-000000000001", actorId: ownerId,
          organizationId, runtimeId: logicalRuntimeId, authorityGeneration: 1, purpose: "owner_runtime",
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(now.getTime() + 20_000).toISOString(), renewAfter: new Date(now.getTime() + 240_000).toISOString(),
        }, { status: 201 });
      }
      expect(url.pathname).not.toBe("/api/collaboration/connections");
      const headers = new Headers(init?.headers);
      const envelope = JSON.parse(Buffer.from(headers.get("x-matrix-collaboration-request") ?? "", "base64url").toString("utf8")) as {
        signature: { method: string; path: string }; proof: string;
      };
      expect(envelope.signature).toMatchObject({ method: init?.method, path: url.pathname });
      signedPaths.push(`${init?.method} ${url.pathname}`);
      if (url.pathname.endsWith("/scopes/preflight")) return Response.json({ eligible: true, resourceRevision: "1", existingScopeId: scopeId, existingLifecycle: "private" });
      if (url.pathname === `/api/collaboration/scopes/${scopeId}`) return Response.json({ id: scopeId, kind: "project" });
      if (url.pathname.endsWith("/members")) return Response.json({ members: [] });
      if (url.pathname.endsWith("/project/inventory")) return Response.json({ scopeId, projectId: "project_private" });
      if (url.pathname.endsWith("/project/confirm")) return Response.json({ status: "prepared" });
      return Response.json({ error: "unavailable" }, { status: 404 });
    });
    const api = createCollaborationDirectApi({ platformBaseUrl: platform, fetchImpl: fetchImpl as typeof fetch,
      getHeaders: async () => ({ Authorization: "Bearer owner" }), clientOrigin: platform, now: () => now });
    const setup = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`;
    await api.post(setup, { kind: "project", resourceId: "project_private", organizationId });
    await api.get(`/api/collaboration/scopes/${scopeId}`);
    await api.get(`/api/collaboration/scopes/${scopeId}/members`);
    await api.get(`/api/collaboration/scopes/${scopeId}/project/inventory`);
    await api.post(`/api/collaboration/scopes/${scopeId}/project/confirm`, { clientRequestId: "50000000-0000-4000-8000-000000000001" });
    // A page reload loses the route hint; Share begins with preflight again and
    // recovers the durable private scope before any inventory or confirm call.
    const reloaded = createCollaborationDirectApi({ platformBaseUrl: platform, fetchImpl: fetchImpl as typeof fetch,
      getHeaders: async () => ({ Authorization: "Bearer owner" }), clientOrigin: platform, now: () => now });
    await reloaded.post(setup, { kind: "project", resourceId: "project_private", organizationId });
    await reloaded.get(`/api/collaboration/scopes/${scopeId}/project/inventory`);
    expect(signedPaths).toEqual([
      `POST ${setup}`, `GET /api/collaboration/scopes/${scopeId}`,
      `GET /api/collaboration/scopes/${scopeId}/members`,
      `GET /api/collaboration/scopes/${scopeId}/project/inventory`,
      `POST /api/collaboration/scopes/${scopeId}/project/confirm`,
      `POST ${setup}`, `GET /api/collaboration/scopes/${scopeId}/project/inventory`,
    ]);
  });

  it("obtains a scope-free ticket and signs only the exact encoded owner setup route", async () => {
    let proofPublicKey = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner");
        const body = JSON.parse(String(init?.body)) as { runtimeId: string; organizationId: string; proofPublicKey: string };
        expect(body).toMatchObject({ runtimeId, organizationId });
        proofPublicKey = body.proofPublicKey;
        const ticket = {
          protocolVersion: 2, ticketId: "10000000-0000-4000-8000-000000000001", nonce: "a".repeat(64),
          actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
          runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        };
        return Response.json({ signedTicket: { ticket, keyId: "platform", signature: "a".repeat(86) }, endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      }
      if (url.pathname === "/api/collaboration/owner-runtime/sessions") {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        const request = JSON.parse(String(init?.body)) as { proofPublicKey: string; possession: string };
        expect(request.proofPublicKey).toBe(proofPublicKey);
        expect(request.possession).toMatch(/^[A-Za-z0-9_-]{86}$/);
        return Response.json({
          protocolVersion: 2, id: "20000000-0000-4000-8000-000000000001",
          actorId: ownerId, organizationId, runtimeId: logicalRuntimeId, authorityGeneration: 1,
          purpose: "owner_runtime", proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(now.getTime() + 20_000).toISOString(), renewAfter: new Date(now.getTime() + 240_000).toISOString(),
        }, { status: 201 });
      }
      expect(url.pathname).toBe(`/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/catalog/resolve`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-matrix-collaboration-session")).toBe("20000000-0000-4000-8000-000000000001");
      const envelope = JSON.parse(Buffer.from(headers.get("x-matrix-collaboration-request")!, "base64url").toString("utf8")) as {
        signature: { path: string; bodyDigest: string }; proof: string;
      };
      expect(envelope.signature.path).toBe(url.pathname);
      expect(verifyEd25519(proofPublicKey, requestSigningPayload(envelope.signature), envelope.proof)).toBe(true);
      return Response.json({ id: "30000000-0000-4000-8000-000000000001", kind: "file", path: "notes.txt" });
    });
    const api = createCollaborationDirectApi({ platformBaseUrl: platform, fetchImpl: fetchImpl as typeof fetch,
      getHeaders: async () => ({ Authorization: "Bearer owner" }), clientOrigin: platform, now: () => now });
    const path = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/catalog/resolve`;
    await expect(api.post(path, { kind: "file", path: "notes.txt", organizationId }))
      .resolves.toMatchObject({ kind: "file", path: "notes.txt" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(api.direct.requestOwnerRuntime(runtimeId, organizationId, "/api/private/files", {})).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("answers a refused setup request with one fresh ticket and one retry", async () => {
    let proofPublicKey = "";
    let tickets = 0;
    let sessions = 0;
    let refused = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        tickets += 1;
        proofPublicKey = (JSON.parse(String(init?.body)) as { proofPublicKey: string }).proofPublicKey;
        const ticket = {
          protocolVersion: 2, ticketId: `1000000${tickets}-0000-4000-8000-000000000001`, nonce: String(tickets).repeat(64),
          actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
          runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        };
        return Response.json({ signedTicket: { ticket, keyId: "platform", signature: "a".repeat(86) }, endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      }
      if (url.pathname === "/api/collaboration/owner-runtime/sessions") {
        sessions += 1;
        return Response.json({
          protocolVersion: 2, id: `2000000${sessions}-0000-4000-8000-000000000001`,
          actorId: ownerId, organizationId, runtimeId: logicalRuntimeId, authorityGeneration: 1,
          purpose: "owner_runtime", proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(now.getTime() + 20_000).toISOString(), renewAfter: new Date(now.getTime() + 240_000).toISOString(),
        }, { status: 201 });
      }
      // The home ends an exhausted or expired session and refuses with the renewable status.
      if (!refused) {
        refused = true;
        return Response.json({ error: "Collaboration request denied" }, { status: 401 });
      }
      expect(new Headers(init?.headers).get("x-matrix-collaboration-session")).toBe("20000002-0000-4000-8000-000000000001");
      return Response.json({ id: "30000000-0000-4000-8000-000000000001", kind: "file", path: "notes.txt" });
    });
    const api = createCollaborationDirectApi({ platformBaseUrl: platform, fetchImpl: fetchImpl as typeof fetch,
      getHeaders: async () => ({ Authorization: "Bearer owner" }), clientOrigin: platform, now: () => now });
    const path = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/catalog/resolve`;
    await expect(api.post(path, { kind: "file", path: "notes.txt", organizationId }))
      .resolves.toMatchObject({ kind: "file", path: "notes.txt" });
    expect([tickets, sessions]).toEqual([2, 2]);
  });

  it("keeps the case of a non-vps logical runtime id the platform returns verbatim", async () => {
    const mixedCaseRuntimeId = "Owner_Runtime";
    let proofPublicKey = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/collaboration/owner-runtime/connections") {
        proofPublicKey = (JSON.parse(String(init?.body)) as { proofPublicKey: string }).proofPublicKey;
        const ticket = {
          protocolVersion: 2, ticketId: "10000000-0000-4000-8000-000000000003", nonce: "c".repeat(64),
          actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
          runtime: { runtimeId: mixedCaseRuntimeId, authorityGeneration: 1 },
          proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          maxActions: 32, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        };
        return Response.json({ signedTicket: { ticket, keyId: "platform", signature: "a".repeat(86) }, endpoint: { origin: platform, protocolVersion: 2 } }, { status: 201 });
      }
      if (url.pathname === "/api/collaboration/owner-runtime/sessions") {
        return Response.json({
          protocolVersion: 2, id: "20000000-0000-4000-8000-000000000003",
          actorId: ownerId, organizationId, runtimeId: mixedCaseRuntimeId, authorityGeneration: 1,
          purpose: "owner_runtime", proofKeyThumbprint: createHash("sha256").update(Buffer.from(proofPublicKey, "base64url")).digest("base64url"),
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          evidenceExpiresAt: new Date(now.getTime() + 20_000).toISOString(), renewAfter: new Date(now.getTime() + 240_000).toISOString(),
        }, { status: 201 });
      }
      expect(url.pathname).toBe(`/api/collaboration/runtimes/${mixedCaseRuntimeId}/scopes/preflight`);
      return Response.json({ eligible: true });
    });
    const api = createCollaborationDirectApi({ platformBaseUrl: platform, fetchImpl: fetchImpl as typeof fetch,
      getHeaders: async () => ({ Authorization: "Bearer owner" }), clientOrigin: platform, now: () => now });
    await expect(api.post(`/api/collaboration/runtimes/${mixedCaseRuntimeId}/scopes/preflight`, { organizationId }))
      .resolves.toMatchObject({ eligible: true });
  });
});
