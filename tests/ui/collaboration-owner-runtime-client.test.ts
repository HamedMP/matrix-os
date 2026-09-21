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
});
