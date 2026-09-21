import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload,
  proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";

const clock = new Date("2026-09-21T12:00:00.000Z");
const ownerId = "user_runtime_owner";
const organizationId = "org_runtime_share";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));

function makeFixture() {
  let member = true;
  const key = generateKeyPairSync("ed25519");
  const proofPublicKey = ed25519PublicKeyRaw(key.publicKey);
  const verifier = new DirectTicketVerifier({
    runtimeId, platformKeys: () => [{ keyId: "platform", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
    controlFresh: () => true, allowedClientOrigins: ["https://app.matrix-os.com"],
    replay: new DirectReplayCache({ now: () => clock }), now: () => clock,
  });
  const precondition = createOrganizationPrecondition({
    source: { assertMembership: async ({ actorId, organizationId: org }) => actorId === ownerId && org === organizationId && member
      ? { member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString() } : { member: false } },
    now: () => clock,
  });
  const service = new OwnerRuntimeSessionService({ verifier, ownerId, runtimeId, organizationPrecondition: precondition, now: () => clock });
  const ticket = (overrides: Record<string, unknown> = {}) => {
    const value = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
      actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
      runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(proofPublicKey),
      maxActions: 8, issuedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 30_000).toISOString(),
      ...overrides,
    };
    return { ticket: value, keyId: "platform", signature: signEd25519(platformKey, ticketSigningPayload(value)) };
  };
  const create = (overrides: Record<string, unknown> = {}) => {
    const signedTicket = ticket(overrides);
    return {
      clientRequestId: randomUUID(), signedTicket, proofPublicKey,
      possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "owner_runtime" })),
      clientOrigin: "https://app.matrix-os.com",
    };
  };
  const signedRequest = (sessionId: string, path: string, body: Uint8Array = new Uint8Array(), method: "GET" | "POST" = "POST") => {
    const signature = {
      protocolVersion: 2, sessionId, method, path, query: "",
      bodyDigest: sha256Hex(body), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
      nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString(),
    };
    return { sessionId, signature, proof: signEd25519(key.privateKey, requestSigningPayload(signature)),
      method, path, query: "", body };
  };
  return { service, create, signedRequest, setMember: (value: boolean) => { member = value; } };
}

describe("owner runtime direct sessions", () => {
  it("admits only exact prepared-project owner routes without granting general scope access", async () => {
    const fixture = makeFixture();
    const session = await fixture.service.create(fixture.create());
    const scopeId = "10000000-0000-4000-8000-000000000001";
    for (const suffix of ["", "/members", "/project/inventory"] as const) {
      await expect(fixture.service.authenticate(fixture.signedRequest(session.id,
        `/api/collaboration/scopes/${scopeId}${suffix}`, new Uint8Array(), "GET"))).resolves.toMatchObject({ actorId: ownerId });
    }
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id,
      `/api/collaboration/scopes/${scopeId}/project/confirm`, new TextEncoder().encode("{}")))).resolves.toMatchObject({ actorId: ownerId });
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id,
      `/api/collaboration/scopes/${scopeId}/chat/messages`, new Uint8Array(), "GET"))).rejects.toMatchObject({ code: "denied" });
    await fixture.service.shutdown();
  });

  it("admits only the configured owner and organization, then signs only exact setup routes", async () => {
    const fixture = makeFixture();
    const body = fixture.create();
    const session = await fixture.service.create(body);
    expect(session).toMatchObject({ actorId: ownerId, organizationId, runtimeId: logicalRuntimeId, purpose: "owner_runtime" });
    expect(session).not.toHaveProperty("scopeId");
    await expect(fixture.service.create(body)).rejects.toMatchObject({ code: "replayed" });
    const path = `/api/collaboration/runtimes/vps%3A11111111-1111-4111-8111-111111111111/catalog/resolve`;
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id, path))).resolves.toMatchObject({ actorId: ownerId, organizationId });
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id, "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001")))
      .rejects.toMatchObject({ code: "denied" });
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id, `/api/collaboration/runtimes/vps%3A22222222-2222-4222-8222-222222222222/scopes`)))
      .rejects.toMatchObject({ code: "denied" });
    fixture.setMember(false);
    await expect(fixture.service.authenticate(fixture.signedRequest(session.id, path))).rejects.toMatchObject({ code: "denied" });
    await fixture.service.shutdown();
  });

  it("denies a signed ticket naming another owner or organization before session admission", async () => {
    const fixture = makeFixture();
    await expect(fixture.service.create(fixture.create({ actorId: "user_other" }))).rejects.toMatchObject({ code: "denied" });
    await expect(fixture.service.create(fixture.create({ organizationId: "org_other" }))).rejects.toMatchObject({ code: "denied" });
    await fixture.service.shutdown();
  });
});
