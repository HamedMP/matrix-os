import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { CollaborationControlClient } from "../../packages/gateway/src/collaboration/control-client.js";
import { createPlatformCollaborationDirectRoutes } from "../../packages/platform/src/collaboration/direct-routes.js";
import { CollaborationControlStream } from "../../packages/platform/src/collaboration/control-stream.js";
import { bootstrapPlatformRuntimeEndpointDatabase, CollaborationRuntimeEndpointRegistry } from "../../packages/platform/src/collaboration/runtime-endpoints.js";
import { CollaborationTicketIssuer } from "../../packages/platform/src/collaboration/ticket-issuer.js";
import { createPlatformCollaborationTestDatabase, createRealPlatformCollaborationTestDatabase, destroyPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = runtimeId.replace(":", "-");
const ownerId = "user_restart_owner";
const organizationId = "org_restart";
const now = new Date("2026-10-22T12:00:00.000Z");
const registration = (generation: number, owner = ownerId) => ({
  protocolVersion: 2, runtimeId: logicalRuntimeId, ownerId: owner, relayHandle: "owner",
  authorityGeneration: generation, publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }],
});

for (const backend of ["fixture", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.MATRIX_TEST_POSTGRES_URL)(`registration recovery (${backend})`, () => {
    async function fixture() {
      const db = backend === "postgres" ? await createRealPlatformCollaborationTestDatabase() : await createPlatformCollaborationTestDatabase();
      await bootstrapPlatformRuntimeEndpointDatabase(db.collaborationDb as never);
      const endpoints = new CollaborationRuntimeEndpointRegistry(db.collaborationDb as never, { now: () => now });
      await endpoints.register({ authenticated: { runtimeId, ownerId, relayHandle: "owner" }, registration: registration(4) });
      const stream = new CollaborationControlStream({
        tickets: endpoints, now: () => now, onAttach: (id) => endpoints.heartbeat(id),
        controlAuthority: { registerTransport: () => undefined, acknowledge: async () => ({ completedDenialIds: [] }) },
      });
      const issuer = new CollaborationTicketIssuer({
        repository: {} as never, endpoints,
        projection: { isCurrentMember: async (input) => input.actorId === ownerId && input.organizationId === organizationId },
        keyring: { activeKeyId: "platform", keys: { platform: Buffer.alloc(32, 1).toString("base64url") } },
        relayOrigin: "https://app.matrix-os.com", resolveOrganization: async () => organizationId, now: () => now,
      });
      const app = createPlatformCollaborationDirectRoutes({
        endpoints, controlStream: stream, issuer, relayOrigin: "https://app.matrix-os.com",
        resolveActor: async () => ownerId,
        authenticateRuntime: async ({ bearerToken }) => bearerToken === "s".repeat(40) ? { runtimeId, ownerId } : null,
        resolveRelayHandle: async () => "owner",
      });
      return { endpoints, stream, issuer, app,
        async ticketCount() {
          const result = await sql<{ count: string }>`SELECT count(*) AS count FROM collaboration_control_upgrade_tickets`.execute(db.collaborationDb);
          return Number(result.rows[0]?.count);
        },
        async close() { await stream.shutdown(); if ("destroy" in db) await db.destroy(); else await destroyPlatformCollaborationTestDatabase(db); } };
    }

    it("returns only the enrolled runtime's generation on 409 without updating registration or issuing an upgrade ticket", async () => {
      const f = await fixture();
      try {
        const before = await f.endpoints.resolve(logicalRuntimeId);
        const response = await f.app.request("/internal/collaboration/runtime-endpoints", {
          method: "POST", headers: { "content-type": "application/json", "x-matrix-runtime-id": runtimeId, authorization: `Bearer ${"s".repeat(40)}` },
          body: JSON.stringify(registration(1)),
        });
        expect(response.status).toBe(409);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ error: "Collaboration state changed", protocolVersion: 2,
          runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 4 } });
        expect(await f.endpoints.resolve(logicalRuntimeId)).toEqual(before);
        expect(await f.ticketCount()).toBe(0);
      } finally { await f.close(); }
    });

    it("recovers a restarted gateway through the real registration route, then requires a live control attach for owner sharing", async () => {
      const f = await fixture();
      const generations: number[] = [];
      const client = new CollaborationControlClient({
        platformBaseUrl: "https://app.matrix-os.com", runtimeId, ownerId, relayHandle: "owner",
        serviceToken: "s".repeat(40), identity: { keyId: "home", publicKey: "B".repeat(43) },
        sessions: { revoke: () => undefined }, now: () => now,
        fetchImpl: (async (_url, init) => {
          generations.push(JSON.parse(String(init?.body)).authorityGeneration);
          return f.app.request("/internal/collaboration/runtime-endpoints", init);
        }) as typeof fetch,
      });
      const request = { clientRequestId: randomUUID(), runtimeId, organizationId, proofPublicKey: "C".repeat(43) };
      try {
        await expect(f.issuer.issueOwnerRuntime({ actorId: ownerId, request })).rejects.toMatchObject({ code: "host_offline" });
        const registered = await client.register();
        expect(generations).toEqual([1, 4]);
        expect(client.authorityGeneration()).toBe(4);
        // Successful registration alone does not manufacture liveness.
        await expect(f.issuer.issueOwnerRuntime({ actorId: ownerId, request })).rejects.toMatchObject({ code: "host_offline" });
        expect(await f.stream.consumeUpgradeTicket(registered.controlTicket, logicalRuntimeId)).toBe(true);
        const connection = f.stream.attach(logicalRuntimeId, { send: () => undefined, close: () => undefined });
        await f.endpoints.heartbeat(logicalRuntimeId);
        await expect(f.issuer.issueOwnerRuntime({ actorId: ownerId, request })).resolves.toMatchObject({ signedTicket: { ticket: { runtime: { authorityGeneration: 4 } } } });
        await expect(f.issuer.issueOwnerRuntime({ actorId: "user_outsider", request })).rejects.toMatchObject({ code: "not_found" });
        await expect(f.issuer.issueOwnerRuntime({ actorId: ownerId, request: { ...request, organizationId: "org_other" } })).rejects.toMatchObject({ code: "not_found" });
        connection.close();
      } finally { await client.shutdown(); await f.close(); }
    });

    it.each(["bad-token", "wrong-owner"])("does not disclose generation to %s", async (mode) => {
      const f = await fixture();
      try {
        const response = await f.app.request("/internal/collaboration/runtime-endpoints", {
          method: "POST", headers: { "content-type": "application/json", "x-matrix-runtime-id": runtimeId,
            authorization: `Bearer ${mode === "bad-token" ? "x".repeat(40) : "s".repeat(40)}` },
          body: JSON.stringify(registration(1, mode === "wrong-owner" ? "user_outsider" : ownerId)),
        });
        expect(response.status).toBe(mode === "bad-token" ? 401 : 403);
        expect(await response.json()).not.toHaveProperty("runtime");
        expect((await f.endpoints.resolve(logicalRuntimeId))?.authorityGeneration).toBe(4);
      } finally { await f.close(); }
    });
  });
}
