import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDriveContextRuntimeClient } from "../../packages/gateway/src/organization-drive/context-runtime-client.js";
import { createPlatformDriveContextRuntimeRoutes } from "../../packages/platform/src/collaboration/drive-context-routes.js";
import { CollaborationRelay } from "../../packages/platform/src/collaboration/relay.js";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, proofKeyThumbprint, signEd25519, ticketSigningPayload } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { DirectTicketVerifier, DirectReplayCache } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { DirectSessionService } from "../../packages/gateway/src/collaboration/direct-sessions.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { registerOrganizationDriveRoutes } from "../../packages/gateway/src/organization-drive/routes.js";
import { createCollaborationTestDatabase, allowAllOrganizationPrecondition } from "./collaboration-test-support.js";
const scopeId = "00000000-0000-7000-8000-000000000001";
const fileId = "00000000-0000-8000-8000-000000000002";
const origin = "https://app.example";
const organizationId = "org_example";
const member = "user_member";
const owner = "user_drive_owner";
const runtimeId = "runtime_authority";
describe("runtime to platform to signed home drive context wiring", () => {
    it("reads as the enrolled member, closes its sessions, and denies revoked membership", async () => {
        const fixture = await createCollaborationTestDatabase();
        let sessions: DirectSessionService | undefined;
        let relay: CollaborationRelay | undefined;
        const client = createDriveContextRuntimeClient;
        let requester: ReturnType<typeof client> | undefined;
        try {
            await bootstrapChatDatabase(fixture.db as never);
            await bootstrapCollaborationDatabase(fixture.db);
            const now = new Date();
            await fixture.db.insertInto("collaboration_scopes").values({ id: scopeId, owner_type: "personal", owner_id: owner, organization_id: organizationId, kind: "folder", resource_id: "folder_drive", parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", authority_runtime_id: runtimeId, execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now }).execute();
            for (const actor of [owner, member])
                await fixture.db.insertInto("collaboration_members").values({ scope_id: scopeId, actor_id: actor, role: actor === owner ? "owner" : "viewer", status: "accepted", organization_id: organizationId, invitation_id: null, invited_by: owner, accepted_at: now, expires_at: null, revision: 1, joined_at: now, updated_at: now, dispositioned_at: null }).execute();
            const repository = new CollaborationRepository(fixture.db, { chatRepository: undefined as never });
            const authority = new CollaborationAuthority(repository, { organizationPrecondition: allowAllOrganizationPrecondition });
            const privateKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));
            const verifier = new DirectTicketVerifier({ runtimeId, platformKeys: () => [{ keyId: "test_key", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(privateKey) }], controlFresh: () => true, allowedClientOrigins: [origin], replay: new DirectReplayCache({ maxEntries: 10 }) });
            sessions = new DirectSessionService({ verifier, authority, repository });
            const home = new Hono().route("/", createDirectSessionRoutes({ sessions }));
            const file = { id: fileId, organizationId, path: "company/plan.md", version: 1, size: 4, sha256: "a".repeat(64), updatedBy: owner, updatedAt: now.toISOString() };
            registerOrganizationDriveRoutes(home, { authority, directSessions: sessions, verifier: undefined as never, organizationDrive: { list: async (input: {
                        prefix?: string;
                    }) => { expect(input.prefix).toBe("部".repeat(260)); return { files: [{ ...file, path: `${input.prefix}/plan.md` }] }; }, readContext: async (input: {
                        revalidate(): Promise<void>;
                    }) => { await input.revalidate(); return { status: "text", file, text: "plan", truncated: false, readOnly: true }; } } as never });
            relay = new CollaborationRelay({ resolveScopeHome: async () => ({ runtimeId, origin: "https://home.example" }), resolveInvitationHome: async () => null, resolveSessionHome: async () => ({ runtimeId, origin: "https://home.example" }), fetchImpl: async (input, init) => home.request(String(input), init) });
            const issuer = { issue: async (input: {
                    actorId: string;
                    request: unknown;
                }) => { const req = input.request as {
                    scopeId: string;
                    proofPublicKey: string;
                    maxActions: number;
                }; const time = new Date(); const ticket = { protocolVersion: 2, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""), actorId: input.actorId, organizationId, resource: { scopeId: req.scopeId, kind: "folder" }, purpose: "direct_session", runtime: { runtimeId, authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(req.proofPublicKey), maxActions: req.maxActions, issuedAt: time.toISOString(), expiresAt: new Date(time.getTime() + 30000).toISOString() }; return { signedTicket: { ticket, keyId: "test_key", signature: signEd25519(privateKey, ticketSigningPayload(ticket)) }, endpoint: { origin, protocolVersion: 2 } }; } };
            const platform = new Hono().route("/", createPlatformDriveContextRuntimeRoutes({ issuer: issuer as never, relay, relayOrigin: origin, authenticateRuntime: async ({ runtimeId: id, bearerToken }) => id === "vps:requester" && bearerToken === "a".repeat(32) ? { runtimeId: id, ownerId: member } : null }));
            requester = client({ platformOrigin: origin, runtimeId: "vps:requester", ownerId: member, serviceToken: "a".repeat(32), fetchImpl: async (input, init) => platform.request(String(input), init) });
            const ref = { kind: "drive" as const, scopeId, organizationId };
            expect(await requester.search({ ...ref, kind: "folder", path: "部".repeat(260) }, {})).toMatchObject({ files: [{ id: fileId }] });
            expect(await requester.read(ref, fileId)).toMatchObject({ text: "plan", readOnly: true });
            await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2 }).where("scope_id", "=", scopeId).where("actor_id", "=", member).execute();
            await expect(requester.search({ ...ref, kind: "folder", path: "部".repeat(260) }, {})).rejects.toMatchObject({ code: "unavailable" });
        }
        finally {
            requester?.close();
            relay?.close();
            await sessions?.shutdown();
            await fixture.destroy();
        }
    }, 30000);
});
