/**
 * S05 / T025, T026: platform-side ticket issuance, runtime endpoint
 * registration and the control stream. Tickets are asymmetric (Ed25519),
 * bind the logical runtime id and authority generation (never a hostname),
 * expire within 30 s and carry the client's proof-key thumbprint. The
 * platform issues them as metadata only; the home is the sole authorization
 * point and verifies them identically whichever ingress delivered them.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationSignedConnectionTicketSchema,
} from "@matrix-os/contracts";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import {
  bootstrapPlatformRuntimeEndpointDatabase,
  CollaborationRuntimeEndpointError,
  CollaborationRuntimeEndpointRegistry,
} from "../../packages/platform/src/collaboration/runtime-endpoints.js";
import {
  CollaborationTicketIssuer,
  CollaborationTicketIssuerError,
  loadTicketSigningKeyring,
} from "../../packages/platform/src/collaboration/ticket-issuer.js";
import {
  ed25519PublicKeyRaw,
  proofKeyThumbprint,
  ticketSigningPayload,
  verifyEd25519,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { CollaborationControlStream } from "../../packages/platform/src/collaboration/control-stream.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-20T12:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const seedA = Buffer.alloc(32, 1).toString("base64url");
const seedB = Buffer.alloc(32, 2).toString("base64url");
const organizationId = "org_test_1";
const invitedActor = "user_platform_invited";

function clientProofKey() {
  const pair = generateKeyPairSync("ed25519");
  const raw = ed25519PublicKeyRaw(pair.publicKey);
  return { pair, raw, thumbprint: proofKeyThumbprint(raw) };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
    runtimeId: logicalRuntimeId,
    ownerId: platformCollaborationActors.owner,
    relayHandle: "owner-handle",
    authorityGeneration: 1,
    publicKeys: [{ keyId: "home-key-1", algorithm: "ed25519", publicKey: clientProofKey().raw }],
    ...overrides,
  };
}

describe("S05 platform tickets, endpoints and control", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let endpoints: CollaborationRuntimeEndpointRegistry;
  let members: Set<string>;
  let issuer: CollaborationTicketIssuer;
  let clock: Date;

  beforeEach(async () => {
    clock = new Date(now);
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await bootstrapPlatformRuntimeEndpointDatabase(fixture.collaborationDb as never);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => clock });
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId,
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [
        { actorId: platformCollaborationActors.owner, status: "accepted" },
        { actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" },
        { actorId: invitedActor, status: "invited" },
      ],
    });
    endpoints = new CollaborationRuntimeEndpointRegistry(fixture.collaborationDb as never, { now: () => clock, keyOverlapMs: 10 * 60_000 });
    members = new Set([platformCollaborationActors.owner, platformCollaborationActors.recipientWithoutComputer, invitedActor]);
    issuer = new CollaborationTicketIssuer({
      keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seedA } },
      repository,
      endpoints,
      resolveOrganization: async (id) => (id === scopeId ? organizationId : null),
      projection: { isCurrentMember: async ({ actorId }) => members.has(actorId) },
      relayOrigin: "https://app.matrix-os.com",
      now: () => clock,
    });
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  describe("runtime endpoint registration (T026)", () => {
    it("registers a relay-routable home by its enrollment identity and returns the record", async () => {
      const record = await endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration(),
      });
      expect(record.runtimeId).toBe(logicalRuntimeId);
      expect(record.relayHandle).toBe("owner-handle");
      expect(record.authorityGeneration).toBe(1);
      expect(record.publicKeys.map((key) => key.keyId)).toEqual(["home-key-1"]);
      expect(await endpoints.resolve(logicalRuntimeId)).toMatchObject({ ownerId: platformCollaborationActors.owner });
    });

    it("rejects endpoint forgery: mismatched runtime, owner or relay handle never registers", async () => {
      for (const [overrides, code] of [
        [{ runtimeId: "vps-22222222-2222-4222-8222-222222222222" }, "runtime_mismatch"],
        [{ ownerId: invitedActor }, "owner_mismatch"],
        [{ relayHandle: "someone-else" }, "relay_handle_mismatch"],
      ] as const) {
        await expect(endpoints.register({
          authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
          registration: registration(overrides),
        })).rejects.toMatchObject({ code });
      }
      expect(await endpoints.resolve(logicalRuntimeId)).toBeNull();
    });

    it("rejects an old protocol with upgrade_required and a hostname-shaped runtime id", async () => {
      await expect(endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration({ protocolVersion: 1 }),
      })).rejects.toMatchObject({ code: "upgrade_required" });
      await expect(endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration({ relayHandle: "203.0.113.9" }),
      })).rejects.toMatchObject({ code: "invalid_registration" });
    });

    it("rejects a future direct origin that is not a public hostname (SSRF-safe, metadata only)", async () => {
      for (const futureDirectOrigin of ["https://localhost", "https://10.0.0.1", "https://home.internal", "https://home.local", "http://home.example.com"]) {
        await expect(endpoints.register({
          authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
          registration: registration({ futureDirectOrigin }),
        })).rejects.toBeInstanceOf(CollaborationRuntimeEndpointError);
      }
      const ok = await endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration({ futureDirectOrigin: "https://home.example.com" }),
      });
      expect(ok.futureDirectOrigin).toBe("https://home.example.com");
    });

    it("keeps generations monotonic and rotates keys with a bounded overlap", async () => {
      const auth = { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" };
      const first = registration({ authorityGeneration: 3, publicKeys: [{ keyId: "k1", algorithm: "ed25519", publicKey: clientProofKey().raw }] });
      await endpoints.register({ authenticated: auth, registration: first });
      await expect(endpoints.register({ authenticated: auth, registration: registration({ authorityGeneration: 2 }) }))
        .rejects.toMatchObject({ code: "stale_generation" });
      const rotated = await endpoints.register({
        authenticated: auth,
        registration: registration({ authorityGeneration: 3, publicKeys: [{ keyId: "k2", algorithm: "ed25519", publicKey: clientProofKey().raw }] }),
      });
      expect(rotated.publicKeys.map((key) => [key.keyId, key.retiredAt !== undefined])).toEqual([["k2", false], ["k1", true]]);
      clock = new Date(clock.getTime() + 11 * 60_000);
      const later = await endpoints.register({ authenticated: auth, registration: registration({ authorityGeneration: 4, publicKeys: rotated.publicKeys.filter((key) => key.keyId === "k2").map(({ keyId, algorithm, publicKey }) => ({ keyId, algorithm, publicKey })) }) });
      expect(later.publicKeys.map((key) => key.keyId)).toEqual(["k2"]);
    });
  });

  describe("connection tickets (T026)", () => {
    beforeEach(async () => {
      await endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration(),
      });
    });

    it("issues an Ed25519-signed ticket bound to actor, organization, resource, purpose, runtime, generation and proof key", async () => {
      const key = clientProofKey();
      const issued = await issuer.issue({
        actorId: platformCollaborationActors.recipientWithoutComputer,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000001", scopeId, purpose: "direct_session", proofPublicKey: key.raw },
      });
      const signed = CollaborationSignedConnectionTicketSchema.parse(issued.signedTicket);
      expect(signed.ticket).toMatchObject({
        protocolVersion: 2,
        actorId: platformCollaborationActors.recipientWithoutComputer,
        organizationId,
        resource: { scopeId, kind: "chat" },
        purpose: "direct_session",
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
        proofKeyThumbprint: key.thumbprint,
      });
      expect(JSON.stringify(signed.ticket)).not.toContain("203.0.113");
      expect(Date.parse(signed.ticket.expiresAt) - Date.parse(signed.ticket.issuedAt)).toBe(30_000);
      expect(issued.endpoint).toEqual({ origin: "https://app.matrix-os.com", protocolVersion: 2 });
      const publicKey = issuer.publicKeys().find((entry) => entry.keyId === signed.keyId)!;
      expect(verifyEd25519(publicKey.publicKey, ticketSigningPayload(signed.ticket), signed.signature)).toBe(true);
      const tampered = { ...signed.ticket, actorId: platformCollaborationActors.owner };
      expect(verifyEd25519(publicKey.publicKey, ticketSigningPayload(tampered), signed.signature)).toBe(false);
    });

    it("never issues to an outsider, a revoked recipient or an unknown scope, and denies generically", async () => {
      members.delete(platformCollaborationActors.recipientWithoutComputer);
      await expect(issuer.issue({
        actorId: platformCollaborationActors.recipientWithoutComputer,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000002", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw },
      })).rejects.toMatchObject({ code: "not_found" });
      await expect(issuer.issue({
        actorId: "user_outsider",
        request: { clientRequestId: "40000000-0000-4000-8000-000000000003", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw },
      })).rejects.toMatchObject({ code: "not_found" });
      await expect(issuer.issue({
        actorId: platformCollaborationActors.owner,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000004", scopeId: "10000000-0000-4000-8000-00000000ffff", purpose: "direct_session", proofPublicKey: clientProofKey().raw },
      })).rejects.toMatchObject({ code: "not_found" });
    });

    it("lets an invited member obtain a direct_session ticket but no events or terminal ticket before accepting", async () => {
      const key = clientProofKey();
      await expect(issuer.issue({
        actorId: invitedActor,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000005", scopeId, purpose: "direct_session", proofPublicKey: key.raw },
      })).resolves.toBeTruthy();
      await expect(issuer.issue({
        actorId: invitedActor,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000006", scopeId, purpose: "events", proofPublicKey: key.raw },
      })).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses when the home is unregistered or its generation is stale", async () => {
      const auth = { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" };
      await endpoints.register({ authenticated: auth, registration: registration({ authorityGeneration: 5 }) });
      await expect(issuer.issue({
        actorId: platformCollaborationActors.owner,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000007", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw },
      })).rejects.toMatchObject({ code: "unavailable" });
    });

    it("rotates platform signing keys with bounded overlap and refuses a keyring without the active key", () => {
      const rotated = new CollaborationTicketIssuer({
        keyring: { activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA } },
        repository,
        endpoints,
        resolveOrganization: async () => organizationId,
        projection: { isCurrentMember: async () => true },
        relayOrigin: "https://app.matrix-os.com",
        now: () => clock,
      });
      expect(rotated.publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2", "ticket-key-1"]);
      expect(() => new CollaborationTicketIssuer({
        keyring: { activeKeyId: "missing", keys: { "ticket-key-2": seedB } },
        repository,
        endpoints,
        resolveOrganization: async () => organizationId,
        projection: { isCurrentMember: async () => true },
        relayOrigin: "https://app.matrix-os.com",
      })).toThrow(CollaborationTicketIssuerError);
      expect(loadTicketSigningKeyring({})).toBeNull();
      expect(loadTicketSigningKeyring({
        MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-1",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-1": seedA }),
      })).toEqual({ activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seedA }, retired: {} });
    });
  });

  describe("control stream (T026)", () => {
    it("admits a runtime once per upgrade ticket, pushes denials and routes acknowledgements", async () => {
      const acks: unknown[] = [];
      const stream = new CollaborationControlStream({
        controlAuthority: {
          registerTransport: () => undefined,
          acknowledge: async (runtime: string, ack: unknown) => { acks.push([runtime, ack]); return { completedDenialIds: ["d1"] }; },
        },
        now: () => clock,
      });
      const ticket = stream.issueUpgradeTicket(logicalRuntimeId);
      expect(stream.consumeUpgradeTicket(ticket, logicalRuntimeId)).toBe(true);
      expect(stream.consumeUpgradeTicket(ticket, logicalRuntimeId)).toBe(false);
      const sent: string[] = [];
      const socket = { send: (value: string) => { sent.push(value); }, close: () => undefined };
      const connection = stream.attach(logicalRuntimeId, socket);
      await stream.deliver(logicalRuntimeId, {
        protocolVersion: 2, type: "denial",
        denial: { actorId: "user_a", generation: 2, fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(), state: "pending" },
      });
      expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "denial", denial: { actorId: "user_a" } });
      await connection.receive(JSON.stringify({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 2, fenceAt: clock.toISOString() }));
      expect(acks).toEqual([[logicalRuntimeId, expect.objectContaining({ runtimeId: logicalRuntimeId })]]);
      await expect(connection.receive(JSON.stringify({ protocolVersion: 1, runtimeId: logicalRuntimeId }))).rejects.toThrow();
      await expect(stream.deliver("vps-unknown", { protocolVersion: 2, type: "generation", runtimeId: "vps-unknown", authorityGeneration: 1 })).rejects.toThrow();
      connection.close();
      await expect(stream.deliver(logicalRuntimeId, { protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 })).rejects.toThrow();
      await stream.shutdown();
    });

    it("bounds upgrade tickets and connections and expires tickets", () => {
      const stream = new CollaborationControlStream({
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        now: () => clock, maxPendingTickets: 2, maxConnections: 1,
      });
      const t1 = stream.issueUpgradeTicket("vps-a");
      stream.issueUpgradeTicket("vps-b");
      stream.issueUpgradeTicket("vps-c");
      expect(stream.consumeUpgradeTicket(t1, "vps-a")).toBe(false);
      const t4 = stream.issueUpgradeTicket("vps-d");
      clock = new Date(clock.getTime() + 31_000);
      expect(stream.consumeUpgradeTicket(t4, "vps-d")).toBe(false);
      stream.attach("vps-a", { send: () => undefined, close: () => undefined });
      expect(() => stream.attach("vps-b", { send: () => undefined, close: () => undefined })).toThrow();
    });
  });
});
