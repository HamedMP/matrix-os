/** T092: two owner homes receive opaque direct bytes and decide admission themselves. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationRelay, RELAY_RUNTIME_HEADER, type RelayHome, type RelayMetadata } from "../../packages/platform/src/collaboration/relay.js";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload,
  proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import {
  allowAllOrganizationPrecondition, createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "../gateway/collaboration-test-support.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const now = new Date("2026-09-21T12:00:00.000Z");
const actorId = "user_t092_owner";
const organizationId = "org_t092";
const origin = "https://app.matrix-os.com";
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));
const platformPublicKey = ed25519PublicKeyRaw(platformKey);
const homes = [
  { scopeId: "10000000-0000-4000-8000-000000000091", runtimeId: "vps:11111111-1111-4111-8111-111111111111", logicalId: "vps-11111111-1111-4111-8111-111111111111", origin: "https://home-a.example.test" },
  { scopeId: "10000000-0000-4000-8000-000000000092", runtimeId: "vps:22222222-2222-4222-8222-222222222222", logicalId: "vps-22222222-2222-4222-8222-222222222222", origin: "https://home-b.example.test" },
] as const;
type Home = typeof homes[number];

function directBody(home: Home, options: {
  issuedAt?: Date; generation?: number; version?: number; signer?: typeof platformKey;
} = {}) {
  const pair = generateKeyPairSync("ed25519");
  const proofPublicKey = ed25519PublicKeyRaw(pair.publicKey);
  const issuedAt = options.issuedAt ?? now;
  const ticket = {
    protocolVersion: options.version ?? COLLABORATION_DIRECT_PROTOCOL_VERSION,
    ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""), actorId, organizationId,
    resource: { scopeId: home.scopeId, kind: "chat" }, purpose: "direct_session",
    runtime: { runtimeId: home.logicalId, authorityGeneration: options.generation ?? 1 },
    proofKeyThumbprint: proofKeyThumbprint(proofPublicKey), maxActions: 3,
    issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
  };
  return {
    clientRequestId: randomUUID(),
    signedTicket: { ticket, keyId: "platform-key-1", signature: signEd25519(options.signer ?? platformKey, ticketSigningPayload(ticket)) },
    proofPublicKey,
    possession: signEd25519(pair.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: ticket.purpose })),
    clientOrigin: origin,
  };
}

describe.skipIf(!connectionString)("T092 two-home direct relay boundary on real Postgres", () => {
  const fixtures: CollaborationTestDatabase[] = [];
  const services: DirectSessionService[] = [];
  const ownerServices: OwnerRuntimeSessionService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown();
    for (const service of ownerServices.splice(0)) await service.shutdown();
    for (const fixture of fixtures.splice(0)) await fixture.destroy();
  });

  it("forwards two homes verbatim while each home rejects invalid and old tickets without V1 proof authority", async () => {
    const apps = new Map<string, Hono>();
    for (const home of homes) {
      const fixture = await createRealCollaborationTestDatabase();
      fixtures.push(fixture);
      await bootstrapChatDatabase(fixture.db);
      await bootstrapCollaborationDatabase(fixture.db);
      await fixture.db.insertInto("collaboration_scopes").values({
        id: home.scopeId, owner_type: "personal", owner_id: actorId, organization_id: organizationId,
        kind: "chat", resource_id: `chat_${home.scopeId.slice(-2)}`, parent_scope_id: null,
        membership_mode: "direct", lifecycle: "shared", authority_runtime_id: home.runtimeId,
        authority_generation: 1, execution_generation: null, execution_eligibility: null,
        deleted_at: null, created_at: now, updated_at: now,
      }).execute();
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: home.scopeId, actor_id: actorId, role: "owner", status: "accepted",
        organization_id: organizationId, invitation_id: null, invited_by: actorId,
        accepted_at: now, expires_at: null, revision: 1, joined_at: now,
        updated_at: now, dispositioned_at: null,
      }).execute();
      const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
      const authority = new CollaborationAuthority(repository, { organizationPrecondition: allowAllOrganizationPrecondition, now: () => now });
      const verifier = new DirectTicketVerifier({
        runtimeId: home.runtimeId,
        platformKeys: () => [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: platformPublicKey }],
        controlFresh: () => true, allowedClientOrigins: [origin], replay: new DirectReplayCache({ now: () => now }), now: () => now,
      });
      const sessions = new DirectSessionService({ verifier, authority, repository, now: () => now, startTimers: false });
      services.push(sessions);
      const ownerRuntimeSessions = new OwnerRuntimeSessionService({
        verifier, ownerId: actorId, runtimeId: home.runtimeId,
        organizationPrecondition: allowAllOrganizationPrecondition, now: () => now,
      });
      ownerServices.push(ownerRuntimeSessions);
      const app = new Hono();
      app.route("/", createDirectSessionRoutes({ sessions, ownerRuntimeSessions }));
      apps.set(home.origin, app);
    }
    const oldHome = { origin: "https://old-home.example.test", logicalId: "vps-33333333-3333-4333-8333-333333333333" };
    const oldApp = new Hono();
    const oldLegacy = vi.fn(() => new Response("legacy served", { status: 200 }));
    oldApp.post("/api/collaboration/runtimes/:runtimeId/scopes", oldLegacy);
    apps.set(oldHome.origin, oldApp);
    const observedBytes: string[] = [];
    const metadata: RelayMetadata[] = [];
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => {
        const home = homes.find((entry) => entry.scopeId === id);
        return home ? { runtimeId: home.logicalId, origin: home.origin } : null;
      },
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (id): Promise<RelayHome | null> => {
        const home = homes.find((entry) => entry.logicalId === id);
        return home ? { runtimeId: home.logicalId, origin: home.origin }
          : id === oldHome.logicalId ? { runtimeId: id, origin: oldHome.origin } : null;
      },
      fetchImpl: async (url, init) => {
        const target = new URL(String(url));
        const app = apps.get(target.origin);
        if (!app) throw new Error("Unmapped test home");
        observedBytes.push(new TextDecoder().decode(init?.body as ArrayBuffer));
        expect(new Headers(init?.headers).has("x-matrix-collaboration-proof")).toBe(false);
        return app.request(new Request(target, init));
      },
      onMetadata: (entry) => metadata.push(entry),
    });
    const send = async (homeId: string, body: unknown, proof = "stale-v1-proof",
      path = "/api/collaboration/direct-sessions") => {
      const bytes = JSON.stringify(body);
      const response = await relay.forward({
        actorId, method: "POST", path, query: "",
        headers: new Headers({ "content-type": "application/json", [RELAY_RUNTIME_HEADER]: homeId,
          "x-matrix-collaboration-proof": proof }),
        body: new TextEncoder().encode(bytes),
      });
      const text = await response.text();
      expect(observedBytes.at(-1)).toBe(bytes);
      return { status: response.status, text };
    };

    for (const home of homes) {
      const response = await send(home.logicalId, directBody(home));
      expect(response.status).toBe(201);
      expect(JSON.parse(response.text)).toMatchObject({ scopeId: home.scopeId, runtimeId: home.logicalId });
    }
    const a = homes[0];
    expect((await send(a.logicalId, directBody(a, { signer: ed25519PrivateKeyFromSeed(Buffer.alloc(32, 9).toString("base64url")) }))).status).toBe(401);
    expect((await send(a.logicalId, directBody(a, { issuedAt: new Date(now.getTime() - 60_000) }))).status).toBe(401);
    expect((await send(a.logicalId, directBody(a, { generation: 2 }))).status).toBe(401);
    expect((await send(homes[1].logicalId, directBody(a))).status).toBe(401);
    expect((await send(a.logicalId, directBody(a, { version: 1 }))).status).toBe(426);
    expect((await send(a.logicalId, { protocolVersion: 1, actorId })).status).toBe(426);
    const oldOwnerProof = await send(a.logicalId, { actorId, ownerId: actorId }, "stale-v1-proof",
      "/api/collaboration/owner-runtime/sessions");
    expect(oldOwnerProof.status).toBe(401);
    expect(oldOwnerProof.text).not.toContain("stale-v1-proof");
    expect((await send(oldHome.logicalId, directBody(a))).status).toBe(404);
    expect(oldLegacy).not.toHaveBeenCalled();
    expect(metadata).toHaveLength(10);
    expect(metadata.every((entry) => entry.outcome === "forwarded")).toBe(true);
    expect(metadata.map((entry) => entry.runtimeId).slice(0, 2)).toEqual(homes.map((home) => home.logicalId));
    const recorded = JSON.stringify(metadata);
    expect(recorded).not.toContain("stale-v1-proof");
    expect(recorded).not.toContain("signedTicket");
    expect(recorded).not.toContain("proofPublicKey");
    expect(recorded).not.toContain("legacy served");
  });
});
