/**
 * S05 full transport path on real PostgreSQL: registration route with runtime
 * headers → one-use control upgrade ticket → WebSocket upgrade → denial fenced
 * by the real control authority and pushed over the socket → acknowledgement
 * persisted → ticket reuse refused → oversized frame rejected.
 */
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Kysely } from "kysely";
import { Hono } from "hono";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_LIMITS, COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { PlatformOrganizationRepository } from "../../packages/platform/src/organizations/repository.js";
import { createCollaborationControlAuthority } from "../../packages/platform/src/collaboration/control-authority.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationDirect } from "../../packages/platform/src/collaboration/direct-wiring.js";
import { ed25519PublicKeyRaw } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createRealPlatformCollaborationTestDatabase, platformCollaborationActors } from "./collaboration-test-support.js";

const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const organizationId = "org_transport_1";
const bearer = "b".repeat(48);
const seed = Buffer.alloc(32, 3).toString("base64url");

describe("S05 direct transport path on real PostgreSQL", () => {
  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("registers, admits one control upgrade per ticket, pushes a denial and persists its acknowledgement", async () => {
    const fixture = await createRealPlatformCollaborationTestDatabase();
    let clock = new Date("2026-09-21T12:00:00.000Z");
    const now = () => clock;
    const db = fixture.collaborationDb as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await bootstrapPlatformOrganizationDatabase(db);
    const organizations = new PlatformOrganizationRepository(db, { now });
    const authority = createCollaborationControlAuthority({ repository: organizations, now, affectedRuntimes: async () => [logicalRuntimeId] });
    const direct = await createPlatformCollaborationDirect({
      db: fixture.collaborationDb as never,
      repository: new PlatformCollaborationRepository(fixture.collaborationDb, { now }),
      controlAuthority: authority,
      projection: { isCurrentMember: async () => true },
      keyring: { activeKeyId: "ticket-key-1", keys: { "ticket-key-1": seed } },
      relayOrigin: "https://app.matrix-os.com",
      resolveActor: async () => null,
      authenticateRuntime: async (input) => input.runtimeId === runtimeId && input.bearerToken === bearer ? { runtimeId, ownerId: platformCollaborationActors.owner } : null,
      resolveRelayHandle: async () => "owner-handle",
      resolveOrganization: async () => organizationId,
      now,
    });
    const app = new Hono();
    direct.register(app);
    const server = createServer();
    server.on("upgrade", (request, socket, head) => { void direct.handleUpgrade(request, socket, head); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    const headers = { "x-matrix-runtime-id": runtimeId, authorization: `Bearer ${bearer}` };
    const sockets: WebSocket[] = [];
    try {
      // Registration through the HTTP route with runtime-header authentication.
      const body = JSON.stringify({
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, runtimeId: logicalRuntimeId, ownerId: platformCollaborationActors.owner,
        relayHandle: "owner-handle", authorityGeneration: 1,
        publicKeys: [{ keyId: "home-key-1", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(generateKeyPairSync("ed25519").publicKey) }],
      });
      expect((await app.request("/internal/collaboration/runtime-endpoints", { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
      const registered = await app.request("/internal/collaboration/runtime-endpoints", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
      expect(registered.status).toBe(200);
      const registration = await registered.json() as { controlTicket: string; platformSigningKeys: Array<{ keyId: string }>; runtime: { runtimeId: string } };
      expect(registration.runtime.runtimeId).toBe(logicalRuntimeId);
      expect(registration.platformSigningKeys.map((key) => key.keyId)).toEqual(["ticket-key-1"]);

      // One-use upgrade ticket: the first socket attaches, a replay is refused with 401.
      const url = `ws://127.0.0.1:${address.port}/internal/collaboration/control?ticket=${registration.controlTicket}`;
      const socket = new WebSocket(url, { headers });
      sockets.push(socket);
      await once(socket, "open");
      await vi.waitFor(() => expect(direct.controlStream.connectedRuntimes()).toEqual([logicalRuntimeId]));
      const replay = new WebSocket(url, { headers });
      sockets.push(replay);
      const replayErrors: string[] = [];
      replay.on("error", (error: Error) => { replayErrors.push(error.message); });
      const [, response] = await once(replay, "unexpected-response") as [unknown, { statusCode: number }];
      expect(response.statusCode).toBe(401);
      // With an unexpected-response listener attached, ws leaves the handshake to the caller: end it.
      replay.terminate();
      await vi.waitFor(() => expect(replay.readyState).toBe(WebSocket.CLOSED));
      expect(replayErrors).toEqual(["WebSocket was closed before the connection was established"]);

      // A real denial: fenced by the authority, delivered through the stream's transport, acknowledged, persisted.
      const frames: Array<Record<string, unknown>> = [];
      socket.on("message", (data) => { frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>); });
      const denial = await authority.fence({ organizationId, actorId: "user_departed000000000000000", generation: 2 });
      expect((await authority.sweep()).delivered).toBe(1);
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "denial")).toBe(true));
      expect(frames.find((frame) => frame.type === "denial")).toMatchObject({ denial: { organizationId, generation: 2, state: "pending" } });
      expect((await authority.describe(denial.denialId))?.state).toBe("pending");
      clock = new Date(clock.getTime() + 1_000);
      socket.send(JSON.stringify({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, runtimeId: logicalRuntimeId, authorityGeneration: 2, fenceAt: clock.toISOString() }));
      await vi.waitFor(async () => expect((await authority.describe(denial.denialId))?.state).toBe("completed"));
      expect(await authority.describeOutbox(denial.denialId)).toEqual([{ runtimeId: logicalRuntimeId, attempts: 1, deadLetter: false, acknowledgedAt: clock.toISOString() }]);
      expect((await direct.endpoints.resolve(logicalRuntimeId))?.lastControlAt).toBe(clock.toISOString());

      // An oversized frame ends the connection instead of being parsed.
      const closed = once(socket, "close");
      socket.send("x".repeat(COLLABORATION_DIRECT_LIMITS.wsFrameBytes + 1));
      const [code] = await closed as [number];
      expect([1008, 1009]).toContain(code);
      await vi.waitFor(() => expect(direct.controlStream.connectedRuntimes()).toEqual([]));
    } finally {
      for (const ws of sockets) if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
      await direct.shutdown();
      await authority.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.destroy();
    }
  });
});
