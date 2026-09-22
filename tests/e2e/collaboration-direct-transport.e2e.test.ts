/**
 * S05 / T029: two in-process homes behind the transparent relay. Proves
 * that the relay performs no per-frame or per-request authorization, that
 * the home rejects a forged ticket the relay forwarded, that a collaborator
 * never reaches a generic owner endpoint, that a reconnect does not extend a
 * lease, and that a partition ends the session at its original deadline.
 *
 * The disposable two-VPS variant of this journey is an unrun gate: it needs
 * enrolled customer VPSes and is recorded in evidence/S05-receipt.md.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes, DIRECT_REQUEST_HEADER, DIRECT_SESSION_HEADER } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { authorize as authorizeRoute } from "../../packages/gateway/src/collaboration/route-support.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import {
  ed25519PrivateKeyFromSeed,
  ed25519PublicKeyRaw,
  possessionPayload,
  proofKeyThumbprint,
  signEd25519,
  ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { collaborationActors, createCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support.js";

const organizationId = "org_e2e";
const platformSeed = Buffer.alloc(32, 3).toString("base64url");
const platformKey = ed25519PrivateKeyFromSeed(platformSeed);
const platformKeys = [{ keyId: "platform-e2e", algorithm: "ed25519" as const, publicKey: ed25519PublicKeyRaw(platformKey) }];
const clientOrigin = "https://app.matrix-os.com";

interface Home { name: string; runtimeId: string; scopeId: string; app: Hono; fixture: CollaborationTestDatabase; sessions: DirectSessionService; ownerCalls: number }

function clientKey() {
  const pair = generateKeyPairSync("ed25519");
  const raw = ed25519PublicKeyRaw(pair.publicKey);
  return { raw, thumbprint: proofKeyThumbprint(raw), sign: (payload: string) => signEd25519(pair.privateKey, payload) };
}

async function startHome(name: string, clock: () => Date, members: Set<string>): Promise<Home> {
  const machineId = `${name.repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`.replace(/[^0-9a-f-]/g, "1");
  const runtimeId = `vps:${machineId}`;
  const scopeId = randomUUID();
  const fixture = await createCollaborationTestDatabase();
  await bootstrapChatDatabase(fixture.db as never);
  await bootstrapCollaborationDatabase(fixture.db);
  const now = clock();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: scopeId, owner_type: "personal", owner_id: collaborationActors.owner, organization_id: organizationId, kind: "chat", resource_id: `chat_${name}`,
    parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", authority_runtime_id: runtimeId, execution_generation: null, execution_eligibility: null,
    deleted_at: null, created_at: now, updated_at: now,
  }).execute();
  for (const [actorId, role] of [[collaborationActors.owner, "owner"], [collaborationActors.editor, "editor"]] as const) {
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: actorId, role, status: "accepted", organization_id: organizationId, invitation_id: null, invited_by: collaborationActors.owner,
      accepted_at: now, expires_at: null, revision: 1, joined_at: now, updated_at: now, dispositioned_at: null,
    }).execute();
  }
  const precondition = createOrganizationPrecondition({
    source: { assertMembership: async ({ actorId }) => (members.has(actorId) ? { member: true, expiresAt: new Date(clock().getTime() + 20_000).toISOString() } : { member: false }) },
    now: clock,
  });
  const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
  const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: clock });
  const verifier = new DirectTicketVerifier({ runtimeId, platformKeys: () => platformKeys, controlFresh: () => true, allowedClientOrigins: [clientOrigin], replay: new DirectReplayCache({ now: clock }), now: clock });
  const sessions = new DirectSessionService({ verifier, authority, repository, now: clock });
  const app = new Hono();
  const home: Home = { name, runtimeId, scopeId, app, fixture, sessions, ownerCalls: 0 };
  app.route("/", createDirectSessionRoutes({ sessions }));
  app.get("/api/collaboration/scopes/:scopeId", async (c) => {
    try {
      const context = await authorizeRoute({ verifier: undefined as never, directSessions: sessions }, c, new Uint8Array(), "read", c.req.param("scopeId"));
      return c.json({ scopeId: context.scopeId, actorId: context.actorId, role: context.role, home: name });
    } catch (error: unknown) {
      return c.json({ error: "Collaboration request denied" }, 401);
    }
  });
  // A generic owner endpoint that must never be reachable through the relay.
  app.get("/api/files/secret", (c) => { home.ownerCalls += 1; return c.text("owner-only"); });
  return home;
}

function ticketFor(home: Home, actorId: string, key: ReturnType<typeof clientKey>, clock: () => Date, tamper?: (ticket: Record<string, unknown>) => void) {
  const issuedAt = clock();
  const ticket: Record<string, unknown> = {
    protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""), actorId, organizationId,
    resource: { scopeId: home.scopeId, kind: "chat" }, purpose: "direct_session", runtime: { runtimeId: home.runtimeId.replace("vps:", "vps-"), authorityGeneration: 1 },
    proofKeyThumbprint: key.thumbprint, maxActions: 1000, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 30_000).toISOString(),
  };
  const signature = signEd25519(platformKey, ticketSigningPayload(ticket));
  tamper?.(ticket);
  return { ticket, keyId: "platform-e2e", signature };
}

describe("S05 direct transport through the relay (two homes)", () => {
  let clock: Date;
  let homes: Home[];
  let relay: CollaborationRelay;
  let relayFetches: number;
  let policyLookups: number;
  let partitioned: boolean;

  beforeEach(async () => {
    clock = new Date("2026-09-21T10:00:00.000Z");
    const members = new Set([collaborationActors.owner, collaborationActors.editor]);
    homes = [await startHome("a", () => clock, members), await startHome("b", () => clock, members)];
    relayFetches = 0;
    policyLookups = 0;
    partitioned = false;
    relay = new CollaborationRelay({
      resolveScopeHome: async (scopeId) => {
        const home = homes.find((entry) => entry.scopeId === scopeId);
        return home ? { runtimeId: home.runtimeId.replace("vps:", "vps-"), origin: `https://home-${home.name}.invalid` } : null;
      },
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (runtimeId) => {
        const home = homes.find((entry) => entry.runtimeId.replace("vps:", "vps-") === runtimeId);
        return home ? { runtimeId, origin: `https://home-${home.name}.invalid` } : null;
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        relayFetches += 1;
        if (partitioned) throw new TypeError("fetch failed");
        const parsed = new URL(url);
        const home = homes.find((entry) => parsed.hostname === `home-${entry.name}.invalid`)!;
        return home.app.request(`${parsed.pathname}${parsed.search}`, init);
      }) as never,
      now: () => clock.getTime(),
    });
  });

  afterEach(async () => {
    for (const home of homes) {
      await home.sessions.shutdown();
      await home.fixture.destroy();
    }
  });

  async function openSession(home: Home, actorId: string, key = clientKey(), tamper?: Parameters<typeof ticketFor>[4]) {
    const signedTicket = ticketFor(home, actorId, key, () => clock, tamper);
    const body = JSON.stringify({
      clientRequestId: randomUUID(), signedTicket, proofPublicKey: key.raw,
      possession: key.sign(possessionPayload({ ticketNonce: signedTicket.ticket.nonce as string, purpose: "direct_session" })), clientOrigin,
    });
    // The client names the home by the ticket's logical runtime id; the relay routes on it and reads nothing else.
    const response = await relay.forward({ actorId, method: "POST", path: "/api/collaboration/direct-sessions", query: "", headers: new Headers({ "content-type": "application/json", "x-matrix-collaboration-runtime": home.runtimeId.replace("vps:", "vps-") }), body: new TextEncoder().encode(body) });
    return { response, key };
  }

  function signedGet(home: Home, sessionId: string, key: ReturnType<typeof clientKey>, path = `/api/collaboration/scopes/${home.scopeId}`) {
    const signature = { protocolVersion: 2, sessionId, method: "GET", path, query: "", bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()), nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
    const envelope = Buffer.from(JSON.stringify({ signature, proof: key.sign(requestSigningPayload(signature)) })).toString("base64url");
    return relay.forward({ actorId: collaborationActors.editor, method: "GET", path, query: "", headers: new Headers({ [DIRECT_SESSION_HEADER]: sessionId, [DIRECT_REQUEST_HEADER]: envelope }), body: null });
  }

  it("routes each client to its resource home with no relay authorization decision and no policy lookup", async () => {
    const a = await openSession(homes[0]!, collaborationActors.editor);
    const b = await openSession(homes[1]!, collaborationActors.editor);
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    const sessionA = await a.response.json() as { id: string };
    const sessionB = await b.response.json() as { id: string };
    const readA = await signedGet(homes[0]!, sessionA.id, a.key);
    const readB = await signedGet(homes[1]!, sessionB.id, b.key);
    expect(await readA.json()).toMatchObject({ home: "a", actorId: collaborationActors.editor, role: "editor" });
    expect(await readB.json()).toMatchObject({ home: "b" });
    // A session for home A is meaningless on home B: the home decides, not the relay.
    const cross = await signedGet(homes[1]!, sessionA.id, a.key);
    expect(cross.status).toBe(401);
    expect(policyLookups).toBe(0);
    expect(relayFetches).toBe(5);
  });

  it("forwards a forged ticket untouched; the home rejects it and issues no session", async () => {
    const forged = await openSession(homes[0]!, collaborationActors.editor, clientKey(), (ticket) => { ticket.actorId = collaborationActors.owner; });
    expect(forged.response.status).toBe(401);
    clock = new Date(clock.getTime() + 31_000);
    const expired = await openSession(homes[0]!, collaborationActors.editor, clientKey(), (ticket) => {
      ticket.issuedAt = new Date(clock.getTime() - 60_000).toISOString();
      ticket.expiresAt = new Date(clock.getTime() - 30_000).toISOString();
    });
    expect(expired.response.status).toBe(401);
    expect(relayFetches).toBe(2);
  });

  it("never exposes a generic owner endpoint to a collaborator", async () => {
    const response = await relay.forward({ actorId: collaborationActors.editor, method: "GET", path: "/api/files/secret", query: "", headers: new Headers(), body: null });
    expect(response.status).toBe(404);
    expect(homes[0]!.ownerCalls + homes[1]!.ownerCalls).toBe(0);
  });

  it("does not extend a lease on reconnect and ends the session at its deadline across a partition", async () => {
    const { response, key } = await openSession(homes[0]!, collaborationActors.editor);
    const session = await response.json() as { id: string; expiresAt: string };
    partitioned = true;
    clock = new Date(clock.getTime() + 60_000);
    const during = await signedGet(homes[0]!, session.id, key);
    expect(during.status).toBe(503);
    partitioned = false;
    // Reconnecting after the partition sees the same original deadline.
    const after = await signedGet(homes[0]!, session.id, key);
    expect(after.status).toBe(200);
    expect(homes[0]!.sessions.describe(session.id)?.expiresAt).toBe(session.expiresAt);
    clock = new Date(Date.parse(session.expiresAt) + 1_000);
    const late = await signedGet(homes[0]!, session.id, key);
    expect(late.status).toBe(401);
    expect(homes[0]!.sessions.describe(session.id)).toBeNull();
  });
});
