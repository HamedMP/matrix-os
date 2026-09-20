import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  COLLABORATION_DIRECT_ROUTES,
  CollaborationConnectionTicketSchema,
  CollaborationControlAckSchema,
  CollaborationControlAssertionSchema,
  CollaborationDenialSchema,
  CollaborationDirectHandshakeFrameSchema,
  CollaborationDirectRequestSignatureSchema,
  CollaborationDirectSessionRenewRequestSchema,
  CollaborationDirectSessionRequestSchema,
  CollaborationDirectSessionSchema,
  CollaborationResourceDirectoryEntrySchema,
  CollaborationRuntimeEndpointRegistrationSchema,
  CollaborationSignedConnectionTicketSchema,
  CollaborationTicketPurposeSchema,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const scopeId = "10000000-0000-4000-8000-000000000001";
const ticketId = "50000000-0000-4000-8000-000000000001";
const sessionId = "60000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const organizationId = "org_2abcDEF123";
const issuedAt = "2026-09-20T12:00:00.000Z";
const expiresAt = "2026-09-20T12:00:30.000Z";
const nonce = "a".repeat(64);
const thumbprint = "b".repeat(43);
const digest = "c".repeat(64);
const signature = "d".repeat(86);

const ticket = {
  protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
  ticketId,
  nonce,
  actorId: "user_2abc",
  organizationId,
  resource: { scopeId, kind: "project" },
  purpose: "direct_session",
  runtime: { runtimeId: "rt_home_a", authorityGeneration: 7 },
  proofKeyThumbprint: thumbprint,
  maxActions: 1,
  issuedAt,
  expiresAt,
};

describe("collaboration direct transport contracts (S02 T011)", () => {
  it("freezes the protocol version, purposes and limits", () => {
    expect(COLLABORATION_DIRECT_PROTOCOL_VERSION).toBe(2);
    expect(CollaborationTicketPurposeSchema.options).toEqual(["direct_session", "events", "terminal", "control", "peer"]);
    expect(COLLABORATION_DIRECT_LIMITS).toMatchObject({
      ticketTtlSeconds: 30,
      identitySessionTtlSeconds: 300,
      organizationEvidenceTtlSeconds: 20,
      evidenceRefreshTargetSeconds: 10,
      streamWatchdogSeconds: 5,
      clockSkewSeconds: 5,
      httpJsonBytes: 96 * 1024,
      webhookBytes: 256 * 1024,
      wsFrameBytes: 64 * 1024,
      pageRows: 100,
      grantsPerScope: 100,
      connectionsPerHome: 256,
      connectionsPerScope: 32,
      connectionsPerActorScope: 4,
      replayCacheEntries: 10_000,
    });
  });

  it("binds a ticket to actor, nonce, proof key, resource, purpose, logical runtime and generation, never a hostname", () => {
    expect(CollaborationConnectionTicketSchema.parse(ticket)).toEqual(ticket);
    for (const forged of [
      { hostname: "home-a.matrix-os.com" },
      { origin: "https://home-a.matrix-os.com" },
      { host: "10.0.0.5" },
      { ownerId: "user_owner" },
      { payerId: "user_owner" },
      { endpoint: "https://evil.example" },
      { runtime: { runtimeId: "rt_home_a", authorityGeneration: 7, hostname: "home-a" } },
      { runtime: { runtimeId: "home-a.matrix-os.com", authorityGeneration: 7 } },
      { runtime: { runtimeId: "10.0.0.5", authorityGeneration: 7 } },
      { runtime: { runtimeId: "rt_home_a", authorityGeneration: 0 } },
      { protocolVersion: 1 },
      { nonce: "short" },
      { proofKeyThumbprint: "not base64url!" },
      { maxActions: 0 },
      { maxActions: 1_001 },
      { purpose: "owner_session" },
      { resource: { scopeId, kind: "everything" } },
      { organizationId: "user_2abc" },
      { expiresAt: "2026-09-20T12:00:31.000Z" },
      { expiresAt: issuedAt },
      { expiresAt: "2026-09-20T11:59:00.000Z" },
    ]) {
      expect(CollaborationConnectionTicketSchema.safeParse({ ...ticket, ...forged }).success).toBe(false);
    }
  });

  it("wraps tickets in a signed envelope with a rotating key id", () => {
    const signed = { ticket, keyId: "platform-2026-09", signature };
    expect(CollaborationSignedConnectionTicketSchema.parse(signed)).toEqual(signed);
    expect(CollaborationSignedConnectionTicketSchema.safeParse({ ...signed, signature: "x" }).success).toBe(false);
    expect(CollaborationSignedConnectionTicketSchema.safeParse({ ...signed, keyId: "../keys" }).success).toBe(false);
  });

  it("exchanges a ticket once with proof of possession and an allowed browser origin", () => {
    const request = {
      clientRequestId: requestId,
      signedTicket: { ticket, keyId: "platform-2026-09", signature },
      proofPublicKey: "e".repeat(43),
      possession: signature,
      clientOrigin: "https://app.matrix-os.com",
    };
    expect(CollaborationDirectSessionRequestSchema.parse(request)).toEqual(request);
    expect(CollaborationDirectSessionRequestSchema.safeParse({ ...request, clientOrigin: "http://app.matrix-os.com" }).success).toBe(false);
    expect(CollaborationDirectSessionRequestSchema.safeParse({ ...request, clientOrigin: "https://app.matrix-os.com/path" }).success).toBe(false);
    expect(CollaborationDirectSessionRequestSchema.safeParse({ ...request, clientOrigin: "https://app.matrix-os.com?x=1" }).success).toBe(false);
    expect(CollaborationDirectSessionRequestSchema.safeParse({ ...request, homeEndpoint: "https://evil.example" }).success).toBe(false);
    expect(CollaborationDirectSessionRequestSchema.safeParse({ ...request, ownerSession: true }).success).toBe(false);
    const renew = { clientRequestId: requestId, signedTicket: request.signedTicket };
    expect(CollaborationDirectSessionRenewRequestSchema.parse(renew)).toEqual(renew);
    expect(CollaborationDirectSessionRenewRequestSchema.safeParse({ clientRequestId: requestId }).success).toBe(false);
  });

  it("keeps sessions short-lived with a separate, shorter organization evidence deadline", () => {
    const session = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      id: sessionId,
      actorId: "user_2abc",
      organizationId,
      scopeId,
      runtimeId: "rt_home_a",
      authorityGeneration: 7,
      purpose: "direct_session",
      proofKeyThumbprint: thumbprint,
      issuedAt,
      expiresAt: "2026-09-20T12:05:00.000Z",
      evidenceExpiresAt: "2026-09-20T12:00:20.000Z",
      renewAfter: "2026-09-20T12:04:00.000Z",
    };
    expect(CollaborationDirectSessionSchema.parse(session)).toEqual(session);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, expiresAt: "2026-09-20T12:05:01.000Z" }).success).toBe(false);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, evidenceExpiresAt: "2026-09-20T12:00:21.000Z" }).success).toBe(false);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, evidenceExpiresAt: "2026-09-20T12:06:00.000Z" }).success).toBe(false);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, renewAfter: "2026-09-20T12:06:00.000Z" }).success).toBe(false);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, ownerCookie: "abc" }).success).toBe(false);
    expect(CollaborationDirectSessionSchema.safeParse({ ...session, protocolVersion: 1 }).success).toBe(false);
  });

  it("signs each request over method, canonical path, query, body digest, conditional headers, session and nonce", () => {
    const request = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      sessionId,
      method: "POST",
      path: "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/grants",
      query: "",
      bodyDigest: digest,
      conditionalHeadersDigest: digest,
      nonce,
      issuedAt,
    };
    expect(CollaborationDirectRequestSignatureSchema.parse(request)).toEqual(request);
    expect(CollaborationDirectRequestSignatureSchema.safeParse({ ...request, path: "//evil" }).success).toBe(false);
    expect(CollaborationDirectRequestSignatureSchema.safeParse({ ...request, path: "/api?x=1" }).success).toBe(false);
    expect(CollaborationDirectRequestSignatureSchema.safeParse({ ...request, method: "TRACE" }).success).toBe(false);
    expect(CollaborationDirectRequestSignatureSchema.safeParse({ ...request, bodyDigest: "abc" }).success).toBe(false);
    expect(CollaborationDirectRequestSignatureSchema.safeParse({ ...request, query: "x".repeat(513) }).success).toBe(false);
  });

  it("verifies WebSocket possession in the first bounded frame before any output", () => {
    const handshake = { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "handshake", sessionId, ticketNonce: nonce, possession: signature };
    expect(CollaborationDirectHandshakeFrameSchema.parse(handshake)).toEqual(handshake);
    expect(CollaborationDirectHandshakeFrameSchema.safeParse({ ...handshake, type: "resume" }).success).toBe(false);
    expect(CollaborationDirectHandshakeFrameSchema.safeParse({ ...handshake, protocolVersion: 1 }).success).toBe(false);
    expect(CollaborationDirectHandshakeFrameSchema.safeParse({ ...handshake, ticket: "x".repeat(64 * 1024 + 1) }).success).toBe(false);
  });

  it("registers homes by relay-routable enrollment handle, not a caller-supplied target URL", () => {
    const registration = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      runtimeId: "rt_home_a",
      ownerId: "user_owner",
      relayHandle: "vps_enroll_2abc",
      authorityGeneration: 7,
      publicKeys: [{ keyId: "home-2026-09", algorithm: "ed25519", publicKey: "f".repeat(43) }],
    };
    expect(CollaborationRuntimeEndpointRegistrationSchema.parse(registration)).toEqual(registration);
    expect(CollaborationRuntimeEndpointRegistrationSchema.parse({ ...registration, futureDirectOrigin: "https://home-a.matrix-os.com" }).futureDirectOrigin).toBe("https://home-a.matrix-os.com");
    for (const forged of [
      { relayHandle: "https://evil.example/relay" },
      { relayHandle: "10.0.0.5:8443" },
      { targetUrl: "https://evil.example" },
      { futureDirectOrigin: "http://home-a.matrix-os.com" },
      { futureDirectOrigin: "https://127.0.0.1" },
      { futureDirectOrigin: "https://home-a.matrix-os.com/api" },
      { publicKeys: [] },
      { publicKeys: [{ keyId: "k", algorithm: "rsa", publicKey: "f".repeat(43) }] },
      { authorityGeneration: 0 },
    ]) {
      expect(CollaborationRuntimeEndpointRegistrationSchema.safeParse({ ...registration, ...forged }).success).toBe(false);
    }
  });

  it("publishes content-free directory entries that are never final authorization", () => {
    const entry = {
      scopeId,
      resourceKind: "chat",
      ownerId: "user_owner",
      organizationId,
      runtimeId: "rt_home_a",
      authorityGeneration: 7,
      title: "Release planning",
      revision: "5",
      caller: { state: "pending" },
    };
    expect(CollaborationResourceDirectoryEntrySchema.parse(entry)).toEqual(entry);
    expect(CollaborationResourceDirectoryEntrySchema.parse({ ...entry, caller: { state: "active", preset: "viewer" } }).caller).toEqual({ state: "active", preset: "viewer" });
    expect(CollaborationResourceDirectoryEntrySchema.safeParse({ ...entry, caller: { state: "active" } }).success).toBe(false);
    expect(CollaborationResourceDirectoryEntrySchema.safeParse({ ...entry, caller: { state: "pending", preset: "viewer" } }).success).toBe(false);
    expect(CollaborationResourceDirectoryEntrySchema.safeParse({ ...entry, title: "/home/matrix/projects/x" }).success).toBe(false);
    expect(CollaborationResourceDirectoryEntrySchema.safeParse({ ...entry, transcript: "hello" }).success).toBe(false);
    expect(CollaborationResourceDirectoryEntrySchema.safeParse({ ...entry, homeOrigin: "https://home-a" }).success).toBe(false);
  });

  it("carries fixed-expiry control assertions and monotonic acknowledgements", () => {
    const assertion = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      type: "membership_assertion",
      organizationId,
      actorId: "user_2abc",
      membershipEpoch: "12",
      member: true,
      requestStartedAt: issuedAt,
      expiresAt: "2026-09-20T12:00:20.000Z",
    };
    expect(CollaborationControlAssertionSchema.parse(assertion)).toEqual(assertion);
    expect(CollaborationControlAssertionSchema.safeParse({ ...assertion, expiresAt: "2026-09-20T12:00:21.000Z" }).success).toBe(false);
    expect(CollaborationControlAssertionSchema.safeParse({ ...assertion, receivedAt: issuedAt }).success).toBe(false);
    const denial = { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "denial", denial: { organizationId, actorId: "user_2abc", generation: 8, fencedAt: issuedAt, ackDeadline: "2026-09-20T12:01:00.000Z", state: "pending" } };
    expect(CollaborationControlAssertionSchema.parse(denial)).toEqual(denial);
    expect(CollaborationDenialSchema.safeParse({ ...denial.denial, state: "completed", acknowledgedAt: undefined }).success).toBe(false);
    expect(CollaborationDenialSchema.parse({ ...denial.denial, state: "completed", acknowledgedAt: "2026-09-20T12:00:30.000Z" }).state).toBe("completed");
    const generation = { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "generation", runtimeId: "rt_home_a", authorityGeneration: 8 };
    expect(CollaborationControlAssertionSchema.parse(generation)).toEqual(generation);
    expect(CollaborationControlAssertionSchema.safeParse({ ...generation, type: "policy_cohort" }).success).toBe(false);
    const ack = { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, runtimeId: "rt_home_a", authorityGeneration: 8, fenceAt: issuedAt };
    expect(CollaborationControlAckSchema.parse(ack)).toEqual(ack);
  });

  it("enumerates exact V1 routes with the home as the only authorization point", () => {
    const keys = COLLABORATION_DIRECT_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("POST /api/collaboration/direct-sessions");
    expect(keys).toContain("POST /api/collaboration/invitations/:invitationId/accept");
    expect(keys).toContain("POST /api/collaboration/scopes/:scopeId/chat/requests/:requestId/retry");
    expect(keys).toContain("POST /api/collaboration/scopes/:scopeId/project/git/actions");
    expect(keys).toContain("GET /api/collaboration/scopes/:scopeId/terminal/ws");
    expect(keys).not.toContain("GET /internal/collaboration/policy");
    expect(keys.some((key) => key.includes("/transfers") || key.includes("/integrations/") || key.includes("/git/operations/"))).toBe(false);
    for (const route of COLLABORATION_DIRECT_ROUTES) {
      expect(route.path.startsWith("/")).toBe(true);
      expect(route.path.includes("*")).toBe(false);
      expect(["home", "platform"]).toContain(route.authority);
      if (route.authority === "home") expect(route.auth).toBe("D");
      if (route.method !== "GET") expect(route.bodyLimit).toBeGreaterThan(0);
    }
  });
});
