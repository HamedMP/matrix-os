import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CollaborationControlClient } from "../../packages/gateway/src/collaboration/control-client.js";
import { DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { requestSigningPayload, sha256Hex } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { OrganizationMembershipClient } from "../../packages/gateway/src/collaboration/organization-membership-client.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload, proofKeyThumbprint, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";

const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = runtimeId.replace(":", "-");
const ownerId = "user_control_owner";
const organizationId = "org_control_owner";
const origin = "https://app.matrix-os.com";
const clock = new Date("2026-10-24T12:00:00.000Z");

describe("owner sessions use endpoint registration, not another member's denial epoch", () => {
  it("keeps the owner admitted after a member denial and fences old tickets only when registration actually advances", async () => {
    const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 41).toString("base64url"));
    const pair = generateKeyPairSync("ed25519");
    const publicKey = ed25519PublicKeyRaw(pair.publicKey);
    let endpointGeneration = 1;
    let ownerIsMember = true;
    let releaseMembership: (() => void) | undefined;
    let holdMembership = false;
    const membership = new OrganizationMembershipClient({ platformBaseUrl: origin, runtimeId,
      serviceToken: "s".repeat(40), now: () => clock,
      fetchImpl: (async () => {
        const response = Response.json([{ protocolVersion: 2, type: "membership_assertion",
          organizationId, actorId: ownerId, membershipEpoch: "1", member: ownerIsMember,
          requestStartedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 20_000).toISOString() }]);
        if (holdMembership) await new Promise<void>(resolve => { releaseMembership = resolve; });
        return response;
      }) as typeof fetch,
    });
    let onMessage!: (raw: string) => void;
    const acknowledgments: Array<{ authorityGeneration: number }> = [];
    const revoke = vi.fn();
    const control = new CollaborationControlClient({
      platformBaseUrl: origin, runtimeId, ownerId, relayHandle: "owner", serviceToken: "s".repeat(40),
      identity: { keyId: "home", publicKey }, sessions: { revoke }, membership, now: () => clock, startTimers: false,
      fetchImpl: (async () => Response.json({ protocolVersion: 2,
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: endpointGeneration, registeredAt: clock.toISOString() },
        platformSigningKeys: [{ keyId: "platform", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
        controlTicket: "t".repeat(43), relay: { origin },
      })) as typeof fetch,
      connect: (_url, _headers, receive) => {
        onMessage = receive;
        return { send: data => { acknowledgments.push(JSON.parse(data)); }, close: () => undefined };
      },
    });
    const verifier = new DirectTicketVerifier({ runtimeId, platformKeys: () => control.platformKeys(),
      controlFresh: () => control.controlFresh(), allowedClientOrigins: [origin],
      replay: new DirectReplayCache({ now: () => clock }), now: () => clock });
    const owner = new OwnerRuntimeSessionService({ verifier, runtimeId, ownerId, now: () => clock,
      runtimeGeneration: () => control.registeredAuthorityGeneration(),
      organizationPrecondition: createOrganizationPrecondition({ now: () => clock,
        source: membership,
      }),
    });
    const request = (generation: number) => {
      const ticket = { protocolVersion: 2, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
        actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
        runtime: { runtimeId: logicalRuntimeId, authorityGeneration: generation }, proofKeyThumbprint: proofKeyThumbprint(publicKey),
        maxActions: 32, issuedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 30_000).toISOString() };
      return { clientRequestId: randomUUID(), signedTicket: { ticket, keyId: "platform", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
        proofPublicKey: publicKey, possession: signEd25519(pair.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "owner_runtime" })), clientOrigin: origin };
    };
    const signedRequest = (sessionId: string) => {
      const signature = { protocolVersion: 2, sessionId, method: "POST" as const,
        path: `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}/scopes/preflight`, query: "",
        bodyDigest: sha256Hex(new Uint8Array()), conditionalHeadersDigest: sha256Hex(new Uint8Array()),
        nonce: randomUUID().replaceAll("-", ""), issuedAt: clock.toISOString() };
      return { sessionId, signature, proof: signEd25519(pair.privateKey, requestSigningPayload(signature)),
        method: signature.method, path: signature.path, query: "", body: new Uint8Array() };
    };
    try {
      expect(control.registeredAuthorityGeneration()).toBeNull();
      const registered = await control.register();
      expect(control.registeredAuthorityGeneration()).toBe(1);
      await control.connectControl(registered.controlTicket);
      const initial = await owner.create(request(1));
      onMessage(JSON.stringify({ protocolVersion: 2, type: "denial", denial: {
        organizationId, actorId: "user_removed_member", generation: 2, state: "pending",
        fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(),
      } }));
      await vi.waitFor(() => expect(acknowledgments.some(ack => ack.authorityGeneration === 2)).toBe(true));
      expect(revoke).toHaveBeenCalledOnce();
      expect(control.authorityGeneration()).toBe(2);
      expect(control.registeredAuthorityGeneration()).toBe(1);
      // The platform endpoint and the tickets it issues remain at 1 after the denial acknowledgment.
      await expect(owner.create(request(endpointGeneration))).resolves.toMatchObject({ authorityGeneration: 1 });
      await expect(owner.authenticate(signedRequest(initial.id))).resolves.toMatchObject({ actorId: ownerId });

      endpointGeneration = 2;
      await control.register();
      expect(control.registeredAuthorityGeneration()).toBe(2);
      await expect(owner.create(request(1))).rejects.toMatchObject({ code: "expired" });
      await expect(owner.authenticate(signedRequest(initial.id))).rejects.toMatchObject({ code: "expired" });
      await expect(owner.create(request(2))).resolves.toMatchObject({ authorityGeneration: 2 });

      const current = await owner.create(request(2));
      membership.evict({ organizationId, actorId: ownerId });
      holdMembership = true;
      const pending = owner.authenticate(signedRequest(current.id));
      // Attach the rejection observer before releasing the delayed positive response.
      const denied = expect(pending).rejects.toMatchObject({ code: "unavailable" });
      await vi.waitFor(() => expect(releaseMembership).toBeTypeOf("function"));
      ownerIsMember = false;
      onMessage(JSON.stringify({ protocolVersion: 2, type: "denial", denial: {
        organizationId, actorId: ownerId, generation: 3, state: "pending",
        fencedAt: clock.toISOString(), ackDeadline: new Date(clock.getTime() + 25_000).toISOString(),
      } }));
      await vi.waitFor(() => expect(acknowledgments.some(ack => ack.authorityGeneration === 3)).toBe(true));
      expect(control.registeredAuthorityGeneration()).toBe(2);
      releaseMembership!();
      await denied;
      holdMembership = false;
      await expect(owner.create(request(2))).rejects.toMatchObject({ code: "denied" });
    } finally {
      await owner.shutdown(); await control.shutdown();
      expect(control.registeredAuthorityGeneration()).toBeNull();
    }
  });
});
