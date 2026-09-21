import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, proofKeyThumbprint, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createCliCollaborationTransport } from "../../packages/sync-client/src/cli/collaboration-direct-transport.js";
import { collaborationActors, createCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support.js";

const platform = "https://app.matrix-os.com";
const relayOrigin = "https://relay.matrix-os.com";
const homeOrigin = "https://owner-home.invalid";
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";
const organizationId = "org_cli_home";
const scopeId = "10000000-0000-4000-8000-000000000a51";
const now = new Date("2026-09-21T15:00:00.000Z");
const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 19).toString("base64url"));

describe("525 CLI through the actual owner Hono routes and transparent relay", () => {
  let fixture: CollaborationTestDatabase;
  let sessions: DirectSessionService;

  afterEach(async () => {
    await sessions?.shutdown();
    await fixture?.destroy();
  });

  it("exchanges a ticket, signs one scope read, and never uses the old content proxy", async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db as never);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: collaborationActors.owner, organization_id: organizationId,
      kind: "project", resource_id: "project_cli_home", parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
      authority_runtime_id: runtimeId, execution_generation: null, execution_eligibility: null,
      deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    for (const [actorId, role] of [[collaborationActors.owner, "owner"], [collaborationActors.editor, "editor"]] as const) {
      await fixture.db.insertInto("collaboration_members").values({
        scope_id: scopeId, actor_id: actorId, role, status: "accepted", organization_id: organizationId,
        invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now, expires_at: null,
        revision: 1, joined_at: now, updated_at: now, dispositioned_at: null,
      }).execute();
    }
    const repository = new CollaborationRepository(fixture.db);
    const precondition = createOrganizationPrecondition({
      source: { async assertMembership({ actorId }) { return [collaborationActors.owner, collaborationActors.editor].includes(actorId as never)
        ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() } : { member: false }; } },
      now: () => now,
    });
    const authority = new CollaborationAuthority(repository, { organizationPrecondition: precondition, now: () => now });
    sessions = new DirectSessionService({
      verifier: new DirectTicketVerifier({ runtimeId,
        platformKeys: () => [{ keyId: "platform", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
        controlFresh: () => true, allowedClientOrigins: [platform], replay: new DirectReplayCache({ now: () => now }), now: () => now,
      }), authority, repository, now: () => now,
    });
    const home = new Hono();
    home.route("/", createDirectSessionRoutes({ sessions }));
    home.route("/", createCollaborationRoutes({ runtimeId, repository, authority, directSessions: sessions,
      verifier: undefined as never, resolveParticipant: async (actorId: string) => ({ actorId, displayName: actorId }),
    } as unknown as CollaborationRouteOptions));
    let homeCalls = 0;
    const relay = new CollaborationRelay({
      resolveScopeHome: async (id) => id === scopeId ? { runtimeId: logicalRuntimeId, origin: homeOrigin } : null,
      resolveInvitationHome: async () => null,
      resolveRuntimeHome: async () => null,
      resolveSessionHome: async (id) => id === logicalRuntimeId ? { runtimeId: logicalRuntimeId, origin: homeOrigin } : null,
      fetchImpl: (async (url: string, init: RequestInit) => {
        homeCalls += 1;
        const parsed = new URL(url);
        return home.request(`${parsed.pathname}${parsed.search}`, init);
      }) as never,
      now: () => now.getTime(),
    });
    let platformContentCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.origin === platform && url.pathname === "/api/collaboration/connections") {
        const body = JSON.parse(String(init?.body)) as { scopeId: string; purpose: string; proofPublicKey: string };
        const ticket = {
          protocolVersion: 2, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
          actorId: collaborationActors.editor, organizationId, resource: { scopeId: body.scopeId, kind: "project" },
          purpose: body.purpose, runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1 },
          proofKeyThumbprint: proofKeyThumbprint(body.proofPublicKey), maxActions: 100,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        };
        return Response.json({ signedTicket: { ticket, keyId: "platform", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
          endpoint: { origin: relayOrigin, protocolVersion: 2 } }, { status: 201 });
      }
      if (url.origin === platform) { platformContentCalls += 1; return Response.json({ error: "retired" }, { status: 404 }); }
      if (url.origin !== relayOrigin) return Response.json({ error: "unavailable" }, { status: 404 });
      const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : null;
      return relay.forward({ actorId: collaborationActors.editor, method: init?.method ?? "GET", path: url.pathname,
        query: url.search.slice(1), headers: new Headers(init?.headers), body });
    }) as typeof fetch;
    const cli = createCliCollaborationTransport({ platformUrl: platform, token: "actor-token", fetchImpl, now: () => now });
    expect(await cli.request(scopeId, "GET", `/api/collaboration/scopes/${scopeId}`))
      .toMatchObject({ id: scopeId, kind: "project", role: "editor" });
    expect(homeCalls).toBe(2);
    expect(platformContentCalls).toBe(0);
  });
});
