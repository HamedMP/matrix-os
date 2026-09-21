/**
 * S05 / T025, T026: platform-side ticket issuance, runtime endpoint
 * registration and the control stream. Tickets are asymmetric (Ed25519),
 * bind the logical runtime id and authority generation (never a hostname),
 * expire within 30 s and carry the client's proof-key thumbprint. The
 * platform issues them as metadata only; the home is the sole authorization
 * point and verifies them identically whichever ingress delivered them.
 */
import { sql } from "kysely";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Hono } from "hono";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  RETIRED_KEY_OVERLAP_MS,
  CollaborationTicketIssuerError,
  loadTicketSigningKeyring,
} from "../../packages/platform/src/collaboration/ticket-issuer.js";
import {
  ed25519PublicKeyRaw,
  proofKeyThumbprint,
  ticketSigningPayload,
  verifyEd25519,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { CollaborationControlStream, ControlStreamNotConnectedError } from "../../packages/platform/src/collaboration/control-stream.js";
import { createPlatformCollaborationDirect } from "../../packages/platform/src/collaboration/direct-wiring.js";
import { createCollaborationControlUpgradeHandler } from "../../packages/platform/src/collaboration/control-upgrade.js";
import {
  createPlatformCollaborationTestDatabase,
  createRealPlatformCollaborationTestDatabase,
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

  // Real PostgreSQL only: PGlite runs one connection, so concurrent transactions cannot contend for the row lock.
  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("serializes concurrent registrations for one runtime so no key is lost and the generation never regresses", async () => {
    const real = await createRealPlatformCollaborationTestDatabase();
    try {
      await bootstrapPlatformRuntimeEndpointDatabase(real.collaborationDb as never);
      const registry = new CollaborationRuntimeEndpointRegistry(real.collaborationDb as never, { now: () => clock, keyOverlapMs: 10 * 60_000 });
      const auth = { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" };
      const keys = ["ka", "kb", "kc", "kd"].map((keyId) => ({ keyId, algorithm: "ed25519" as const, publicKey: clientProofKey().raw }));
      const results = await Promise.allSettled(keys.map((key, index) => registry.register({
        authenticated: auth,
        registration: registration({ authorityGeneration: 2 + (index % 2), publicKeys: [key] }),
      })));
      // Every registration either lands or is refused as stale (generation 2 after generation 3); none corrupts the row.
      expect(results.every((result) => result.status === "fulfilled" || (result.reason as { code?: string }).code === "stale_generation")).toBe(true);
      const stored = await registry.resolve(logicalRuntimeId);
      expect(stored!.authorityGeneration).toBe(3);
      const landed = results.flatMap((result, index) => (result.status === "fulfilled" ? [keys[index]!.keyId] : []));
      expect(stored!.publicKeys.map((key) => key.keyId).sort()).toEqual(landed.sort());
      expect(stored!.publicKeys.filter((key) => key.retiredAt === undefined)).toHaveLength(1);
    } finally {
      await real.destroy();
    }
  });

  describe("connection tickets (T026)", () => {
    beforeEach(async () => {
      await endpoints.register({
        authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" },
        registration: registration(),
      });
      await endpoints.heartbeat(logicalRuntimeId);
    });

    it("binds each resource's own authority generation, not the home's endpoint generation", async () => {
      const projectScope = "10000000-0000-4000-8000-000000000009";
      await repository.applyDirectoryEvent({
        eventId: "20000000-0000-4000-8000-000000000009", scopeId: projectScope, runtimeId, ownerId: platformCollaborationActors.owner, kind: "project",
        authorityGeneration: 7, metadataRevision: 1, recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }],
      });
      const scoped = new CollaborationTicketIssuer({
        keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seedA } }, repository, endpoints,
        resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock,
      });
      const chat = await scoped.issue({ actorId: platformCollaborationActors.owner, request: { clientRequestId: "40000000-0000-4000-8000-000000000011", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw } });
      const project = await scoped.issue({ actorId: platformCollaborationActors.owner, request: { clientRequestId: "40000000-0000-4000-8000-000000000012", scopeId: projectScope, purpose: "direct_session", proofPublicKey: clientProofKey().raw } });
      expect(chat.signedTicket.ticket.runtime).toEqual({ runtimeId: logicalRuntimeId, authorityGeneration: 1 });
      expect(project.signedTicket.ticket.runtime).toEqual({ runtimeId: logicalRuntimeId, authorityGeneration: 7 });
    });

    it("reports host_offline for a home that never attached its control stream or went stale", async () => {
      const key = clientProofKey();
      const request = (id: string) => ({ actorId: platformCollaborationActors.owner, request: { clientRequestId: id, scopeId, purpose: "direct_session" as const, proofPublicKey: key.raw } });
      await expect(issuer.issue(request("40000000-0000-4000-8000-000000000021"))).resolves.toBeTruthy();
      clock = new Date(clock.getTime() + 61_000);
      await expect(issuer.issue(request("40000000-0000-4000-8000-000000000022"))).rejects.toMatchObject({ code: "host_offline" });
      await endpoints.heartbeat(logicalRuntimeId);
      await expect(issuer.issue(request("40000000-0000-4000-8000-000000000023"))).resolves.toBeTruthy();
      const cold = "vps:33333333-3333-4333-8333-333333333333";
      await endpoints.register({ authenticated: { runtimeId: cold, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration({ runtimeId: "vps-33333333-3333-4333-8333-333333333333" }) });
      const coldScope = "10000000-0000-4000-8000-000000000033";
      await repository.applyDirectoryEvent({ eventId: "20000000-0000-4000-8000-000000000033", scopeId: coldScope, runtimeId: cold, ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }] });
      const coldIssuer = new CollaborationTicketIssuer({ keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seedA } }, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock });
      await expect(coldIssuer.issue({ actorId: platformCollaborationActors.owner, request: { clientRequestId: "40000000-0000-4000-8000-000000000024", scopeId: coldScope, purpose: "direct_session", proofPublicKey: key.raw } })).rejects.toMatchObject({ code: "host_offline" });
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

    it("refuses when the scope's home is not registered for its owner", async () => {
      const other = "10000000-0000-4000-8000-000000000077";
      await repository.applyDirectoryEvent({ eventId: "20000000-0000-4000-8000-000000000077", scopeId: other, runtimeId: "vps:44444444-4444-4444-8444-444444444444", ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }] });
      const anyOrg = new CollaborationTicketIssuer({ keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seedA } }, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock });
      await expect(anyOrg.issue({
        actorId: platformCollaborationActors.owner,
        request: { clientRequestId: "40000000-0000-4000-8000-000000000007", scopeId: other, purpose: "direct_session", proofPublicKey: clientProofKey().raw },
      })).rejects.toMatchObject({ code: "unavailable" });
    });

    it("rotates platform signing keys with bounded overlap and refuses a keyring without the active key", () => {
      const rotated = new CollaborationTicketIssuer({
        keyring: { activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA }, retiredAt: { "ticket-key-1": clock.toISOString() } },
        repository,
        endpoints,
        resolveOrganization: async () => organizationId,
        projection: { isCurrentMember: async () => true },
        relayOrigin: "https://app.matrix-os.com",
        now: () => clock,
      });
      expect(rotated.publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2", "ticket-key-1"]);
      // A retired key is published only for the rotation overlap window after its retirement, then dropped.
      clock = new Date(clock.getTime() + RETIRED_KEY_OVERLAP_MS + 1);
      expect(rotated.publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2"]);
      const explicit = new CollaborationTicketIssuer({
        keyring: { activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA }, retiredAt: { "ticket-key-1": new Date(clock.getTime() - RETIRED_KEY_OVERLAP_MS + 5_000).toISOString() } },
        repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock,
      });
      expect(explicit.publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2", "ticket-key-1"]);
      clock = new Date(clock.getTime() + 5_001);
      expect(explicit.publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2"]);
      expect(loadTicketSigningKeyring({
        MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-2",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-2": seedB }),
        MATRIX_COLLABORATION_TICKET_RETIRED_KEYS: JSON.stringify({ "ticket-key-1": seedA }),
        MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify({ "ticket-key-1": "2026-09-21T00:00:00.000Z" }),
      })).toEqual({ activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA }, retiredAt: { "ticket-key-1": "2026-09-21T00:00:00.000Z" } });
      expect(loadTicketSigningKeyring({
        MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-2",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-2": seedB }),
        MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify({ "ticket-key-1": "not a time" }),
      })).toBeNull();
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

  describe("retired signing keys (T026)", () => {
    beforeEach(async () => {
      await repository.applyDirectoryEvent({ eventId: "20000000-0000-4000-8000-000000000081", scopeId, runtimeId, ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1, metadataRevision: 1, recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }] });
    });

    it("refuses a retired key without a retirement time so restarts cannot republish it forever", () => {
      const withoutRetiredAt = { activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA } };
      // Retirement must be configuration, not process uptime: three restarts long past the
      // overlap must never hand the retired key back to homes.
      for (let restart = 0; restart < 3; restart += 1) {
        clock = new Date(clock.getTime() + RETIRED_KEY_OVERLAP_MS + 60_000);
        expect(() => new CollaborationTicketIssuer({ keyring: withoutRetiredAt, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock })).toThrow(CollaborationTicketIssuerError);
      }
      // The environment loader fails closed the same way, so the route answers unavailable
      // instead of publishing a key whose retirement nothing records.
      expect(loadTicketSigningKeyring({
        MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-2",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-2": seedB }),
        MATRIX_COLLABORATION_TICKET_RETIRED_KEYS: JSON.stringify({ "ticket-key-1": seedA }),
      })).toBeNull();
      // A retirement time that names no retired key is a typo, not a retirement.
      expect(loadTicketSigningKeyring({
        MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "ticket-key-2",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "ticket-key-2": seedB }),
        MATRIX_COLLABORATION_TICKET_RETIRED_KEYS: JSON.stringify({ "ticket-key-1": seedA }),
        MATRIX_COLLABORATION_TICKET_RETIRED_AT: JSON.stringify({ "ticket-key-9": clock.toISOString() }),
      })).toBeNull();

      const retiredAt = { "ticket-key-1": new Date(clock.getTime() - RETIRED_KEY_OVERLAP_MS + 5_000).toISOString() };
      const keyring = { ...withoutRetiredAt, retiredAt };
      expect(new CollaborationTicketIssuer({ keyring, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock }).publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2", "ticket-key-1"]);
      clock = new Date(clock.getTime() + 5_001);
      // The recorded retirement survives every restart: the key stays dropped.
      for (let restart = 0; restart < 3; restart += 1) {
        clock = new Date(clock.getTime() + 60_000);
        expect(new CollaborationTicketIssuer({ keyring, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock }).publicKeys().map((key) => key.keyId)).toEqual(["ticket-key-2"]);
      }
      // A retirement dated in the future would never expire either.
      expect(() => new CollaborationTicketIssuer({
        keyring: { ...withoutRetiredAt, retiredAt: { "ticket-key-1": new Date(clock.getTime() + 60_000).toISOString() } }, repository, endpoints, resolveOrganization: async () => organizationId, projection: { isCurrentMember: async () => true }, relayOrigin: "https://app.matrix-os.com", now: () => clock,
      })).toThrow(CollaborationTicketIssuerError);
      // The overlap window itself is unchanged.
      expect(RETIRED_KEY_OVERLAP_MS).toBe(15 * 60_000);
    });

    it("contains an unusable retirement time in the ticket route instead of failing platform startup", async () => {
      // A retirement dated past the clock skew is refused by the issuer. Refusing it must make
      // the ticket route unavailable, not abort the composition root that builds every other
      // collaboration surface: a mistyped year in the operator's configuration cannot be a
      // platform-wide outage.
      const unusableRetirement = new Date(clock.getTime() + 3 * 60 * 60_000).toISOString();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const direct = await createPlatformCollaborationDirect({
        db: fixture.collaborationDb as never,
        repository,
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        projection: { isCurrentMember: async () => true },
        keyring: { activeKeyId: "ticket-key-2", keys: { "ticket-key-2": seedB }, retired: { "ticket-key-1": seedA }, retiredAt: { "ticket-key-1": unusableRetirement } },
        relayOrigin: "https://app.matrix-os.com",
        resolveActor: async () => platformCollaborationActors.owner,
        authenticateRuntime: async () => ({ runtimeId, ownerId: platformCollaborationActors.owner }),
        resolveRelayHandle: async () => "owner-handle",
        resolveOrganization: async () => organizationId,
        now: () => clock,
      });
      try {
        // The issuer is absent, exactly as it is when no signing keys are configured at all.
        expect(direct.issuer).toBeNull();
        const app = new Hono();
        direct.register(app);
        const ticket = await app.request("/api/collaboration/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientRequestId: "30000000-0000-4000-8000-000000000001", scopeId, purpose: "stream", proofPublicKey: clientProofKey().raw }),
        });
        expect(ticket.status).toBe(503);
        // Registration still answers, and it publishes no key at all: the retired key whose
        // retirement could not be honoured is never handed to a home.
        const registered = await app.request("/internal/collaboration/runtime-endpoints", {
          method: "POST",
          headers: { "content-type": "application/json", "x-matrix-runtime-id": runtimeId, authorization: `Bearer ${"b".repeat(48)}` },
          body: JSON.stringify(registration()),
        });
        expect(registered.status).toBe(200);
        expect((await registered.json() as { platformSigningKeys: Array<{ keyId: string }> }).platformSigningKeys).toEqual([]);
        // The misconfigured value itself never reaches the log.
        const logged = warn.mock.calls.map((call) => call.map((part) => String(part)).join(" ")).join("\n");
        expect(logged).toContain("ticket signing configuration");
        expect(logged).not.toContain(unusableRetirement);
        expect(logged).not.toContain(seedA);
      } finally {
        await direct.shutdown();
        warn.mockRestore();
      }
    });
  });

  describe("control stream (T026)", () => {
    it("keeps a pong-responsive idle home ticket-ready beyond the liveness window", async () => {
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      const stream = new CollaborationControlStream({
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        tickets: endpoints, onAttach: (id) => endpoints.heartbeat(id), now: () => clock,
      });
      const handler = createCollaborationControlUpgradeHandler({
        stream,
        authenticateRuntime: async () => ({ runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }),
        heartbeatIntervalMs: 20,
      });
      const server = createServer();
      server.on("upgrade", (request, socket, head) => { void handler.handleUpgrade(request, socket, head); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server has no port");
      const ticket = await stream.issueUpgradeTicket(logicalRuntimeId);
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/collaboration/control?ticket=${ticket}`, {
        headers: { "x-matrix-runtime-id": runtimeId, authorization: `Bearer ${"a".repeat(32)}` },
      });
      try {
        await once(socket, "open");
        await vi.waitFor(async () => expect((await endpoints.resolve(logicalRuntimeId))?.lastControlAt).toBe(clock.toISOString()));
        clock = new Date(clock.getTime() + 61_000);
        await vi.waitFor(async () => expect((await endpoints.resolve(logicalRuntimeId))?.lastControlAt).toBe(clock.toISOString()), { timeout: 1_500 });
        await expect(issuer.issue({ actorId: platformCollaborationActors.owner, request: {
          clientRequestId: "40000000-0000-4000-8000-000000000025", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw,
        } })).resolves.toBeTruthy();
      } finally {
        socket.terminate();
        await stream.shutdown();
        handler.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("keeps an idle attached home ticket-ready through generation keepalives the home acknowledges", async () => {
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      const acks: unknown[] = [];
      const stream = new CollaborationControlStream({
        controlAuthority: {
          registerTransport: () => undefined,
          acknowledge: async (_runtime: string, ack: unknown) => { acks.push(ack); return { completedDenialIds: [] }; },
        },
        tickets: endpoints,
        onAttach: (id) => endpoints.heartbeat(id),
        now: () => clock,
        keepalive: { intervalMs: 20, authorityGeneration: async (id) => (await endpoints.resolve(id))?.authorityGeneration ?? null },
      });
      const sent: string[] = [];
      const socket = { send: (value: string) => { sent.push(value); }, close: () => undefined };
      const connection = stream.attach(logicalRuntimeId, socket);
      try {
        // The platform sends a bounded, schema-valid generation frame on its own without any denial.
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
        const frame = JSON.parse(sent[0]!) as { type: string; runtimeId: string; authorityGeneration: number; protocolVersion: number };
        expect(frame).toEqual({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 });
        // A silent home goes stale even while its socket stays attached.
        clock = new Date(clock.getTime() + 61_000);
        await expect(issuer.issue({ actorId: platformCollaborationActors.owner, request: {
          clientRequestId: "40000000-0000-4000-8000-000000000026", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw,
        } })).rejects.toMatchObject({ code: "host_offline" });
        // The home's keepalive acknowledgement (its fence is unchanged, so it completes nothing) is the liveness signal.
        await connection.receive(JSON.stringify({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 1, fenceAt: "1970-01-01T00:00:00.000Z" }));
        expect(acks).toHaveLength(1);
        await vi.waitFor(async () => expect((await endpoints.resolve(logicalRuntimeId))?.lastControlAt).toBe(clock.toISOString()));
        await expect(issuer.issue({ actorId: platformCollaborationActors.owner, request: {
          clientRequestId: "40000000-0000-4000-8000-000000000027", scopeId, purpose: "direct_session", proofPublicKey: clientProofKey().raw,
        } })).resolves.toBeTruthy();
        // Keepalives stop with the connection.
        connection.close();
        const after = sent.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(sent.length).toBe(after);
      } finally {
        await stream.shutdown();
      }
    });

    it("admits a runtime once per upgrade ticket, pushes denials and routes acknowledgements", async () => {
      const acks: unknown[] = [];
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      const stream = new CollaborationControlStream({
        controlAuthority: {
          registerTransport: () => undefined,
          acknowledge: async (runtime: string, ack: unknown) => { acks.push([runtime, ack]); return { completedDenialIds: ["d1"] }; },
        },
        tickets: endpoints,
        onAttach: (id) => endpoints.heartbeat(id),
        now: () => clock,
      });
      const ticket = await stream.issueUpgradeTicket(logicalRuntimeId);
      // A second instance sharing the store admits the ticket exactly once.
      const otherInstance = new CollaborationControlStream({ controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) }, tickets: endpoints, now: () => clock });
      await expect(otherInstance.consumeUpgradeTicket(ticket, "vps-someone-else")).resolves.toBe(false);
      await expect(otherInstance.consumeUpgradeTicket(ticket, logicalRuntimeId)).resolves.toBe(true);
      await expect(stream.consumeUpgradeTicket(ticket, logicalRuntimeId)).resolves.toBe(false);
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
      await expect(stream.deliver("vps-unknown", { protocolVersion: 2, type: "generation", runtimeId: "vps-unknown", authorityGeneration: 1 })).rejects.toBeInstanceOf(ControlStreamNotConnectedError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await endpoints.resolve(logicalRuntimeId))!.lastControlAt).toBe(clock.toISOString());
      connection.close();
      await expect(stream.deliver(logicalRuntimeId, { protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 })).rejects.toBeInstanceOf(ControlStreamNotConnectedError);
      await stream.shutdown();
    });

    it("issues an upgrade ticket and prunes expired ones atomically", async () => {
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      await sql`CREATE OR REPLACE FUNCTION matrix_test_refuse_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pruning refused'; END; $$ LANGUAGE plpgsql`.execute(fixture.collaborationDb);
      await sql`CREATE TRIGGER matrix_test_refuse_prune BEFORE DELETE ON collaboration_control_upgrade_tickets FOR EACH STATEMENT EXECUTE FUNCTION matrix_test_refuse_delete()`.execute(fixture.collaborationDb);
      try {
        const expiresAt = new Date(clock.getTime() + 30_000);
        await expect(endpoints.issueControlTicket(logicalRuntimeId, "t".repeat(43), expiresAt)).rejects.toThrow();
        // The ticket was never committed: registration reported failure and nothing half-issued remains.
        const rows = await fixture.collaborationDb.selectFrom("collaboration_control_upgrade_tickets").select("runtime_id").where("runtime_id", "=", logicalRuntimeId).execute();
        expect(rows).toEqual([]);
      } finally {
        await sql`DROP TRIGGER matrix_test_refuse_prune ON collaboration_control_upgrade_tickets`.execute(fixture.collaborationDb);
        await sql`DROP FUNCTION matrix_test_refuse_delete()`.execute(fixture.collaborationDb);
      }
    });

    it("bounds pending acknowledgement work per connection and drains it on shutdown", async () => {
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      let releaseAck!: () => void;
      const blocked = new Promise<void>((resolve) => { releaseAck = resolve; });
      let acknowledged = 0;
      const stream = new CollaborationControlStream({
        controlAuthority: {
          registerTransport: () => undefined,
          acknowledge: async () => { await blocked; acknowledged += 1; return { completedDenialIds: [] }; },
        },
        tickets: endpoints, now: () => clock,
      });
      const connection = stream.attach(logicalRuntimeId, { send: () => undefined, close: () => undefined });
      const ack = JSON.stringify({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 1, fenceAt: clock.toISOString() });
      const pending: Promise<void>[] = [];
      for (let index = 0; index < CollaborationControlStream.MAX_PENDING_FRAMES; index += 1) pending.push(connection.receive(ack));
      // One frame past the bound is refused instead of queued.
      await expect(connection.receive(ack)).rejects.toThrow(/pending/i);
      let drained = false;
      const shutdown = stream.shutdown().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      releaseAck();
      await Promise.all(pending);
      await shutdown;
      expect(acknowledged).toBe(CollaborationControlStream.MAX_PENDING_FRAMES);
    });

    it("refuses acknowledgement work once the connection or the stream is closed", async () => {
      await endpoints.register({ authenticated: { runtimeId, ownerId: platformCollaborationActors.owner, relayHandle: "owner-handle" }, registration: registration() });
      let releaseAck!: () => void;
      const blocked = new Promise<void>((resolve) => { releaseAck = resolve; });
      let started = 0;
      let acknowledged = 0;
      const stream = new CollaborationControlStream({
        controlAuthority: {
          registerTransport: () => undefined,
          acknowledge: async () => { started += 1; await blocked; acknowledged += 1; return { completedDenialIds: [] }; },
        },
        tickets: endpoints, now: () => clock,
      });
      const connection = stream.attach(logicalRuntimeId, { send: () => undefined, close: () => undefined });
      const ack = JSON.stringify({ protocolVersion: 2, runtimeId: logicalRuntimeId, authorityGeneration: 1, fenceAt: clock.toISOString() });
      const admitted = connection.receive(ack);
      connection.close();
      // A frame delivered after the socket closed must start no new authority work:
      // shutdown can only drain the chain it captured when the connection closed.
      await expect(connection.receive(ack)).rejects.toThrow(/closed/i);
      let drained = false;
      const shutdown = stream.shutdown().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      expect(started).toBe(1);
      releaseAck();
      await admitted;
      await shutdown;
      expect(acknowledged).toBe(1);
      // After shutdown the stream admits neither frames nor attachments.
      await expect(connection.receive(ack)).rejects.toThrow(/closed|shutting down/i);
      expect(() => stream.attach("vps-late", { send: () => undefined, close: () => undefined })).toThrow(/shutting down/i);
      expect(started).toBe(1);
    });

    it("evicts a silent control connection before refusing a new one at the connection cap", async () => {
      const closed: string[] = [];
      const stream = new CollaborationControlStream({
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        tickets: endpoints, now: () => clock, maxConnections: 1, connectionIdleTtlMs: 60_000,
      });
      stream.attach("vps-silent", { send: () => undefined, close: () => { closed.push("vps-silent"); } });
      expect(stream.connectedRuntimes()).toEqual(["vps-silent"]);
      // A half-open socket raises no close event and acknowledges nothing; the registry
      // must sweep it before the cap refuses a live home.
      clock = new Date(clock.getTime() + 61_000);
      stream.attach("vps-live", { send: () => undefined, close: () => undefined });
      expect(closed).toEqual(["vps-silent"]);
      expect(stream.connectedRuntimes()).toEqual(["vps-live"]);
      await expect(stream.deliver("vps-silent", { protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "generation", runtimeId: "vps-silent", authorityGeneration: 1 }))
        .rejects.toBeInstanceOf(ControlStreamNotConnectedError);
      await stream.shutdown();
    });

    it("sweeps a silent control connection on its own timer and stops the timer on shutdown", async () => {
      let closedCount = 0;
      const stream = new CollaborationControlStream({
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        tickets: endpoints, now: () => clock, connectionIdleTtlMs: 60_000, sweepIntervalMs: 5,
      });
      const connection = stream.attach("vps-partitioned", { send: () => undefined, close: () => { closedCount += 1; } });
      // Liveness keeps the reservation while the home talks.
      clock = new Date(clock.getTime() + 30_000);
      connection.heartbeat();
      clock = new Date(clock.getTime() + 40_000);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stream.connectedRuntimes()).toEqual(["vps-partitioned"]);
      clock = new Date(clock.getTime() + 61_000);
      await vi.waitFor(() => { expect(stream.connectedRuntimes()).toEqual([]); }, { timeout: 1_000, interval: 5 });
      expect(closedCount).toBe(1);
      await stream.shutdown();
      expect(stream.sweepRunning()).toBe(false);
    });

    it("expires stored upgrade tickets and bounds connections per instance", async () => {
      const stream = new CollaborationControlStream({
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
        tickets: endpoints, now: () => clock, maxConnections: 1,
      });
      const t4 = await stream.issueUpgradeTicket("vps-d");
      clock = new Date(clock.getTime() + 31_000);
      await expect(stream.consumeUpgradeTicket(t4, "vps-d")).resolves.toBe(false);
      stream.attach("vps-a", { send: () => undefined, close: () => undefined });
      expect(() => stream.attach("vps-b", { send: () => undefined, close: () => undefined })).toThrow();
    });
  });
});
