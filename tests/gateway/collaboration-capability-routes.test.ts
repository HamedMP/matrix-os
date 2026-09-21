import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollaborationGrantSchema } from "@matrix-os/contracts";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { collaborationIds, createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const ownerId = "user_capability_owner";
const memberId = "user_capability_member";
const outsiderId = "user_capability_outsider";
const organizationId = "org_capability_routes";
const scopeId = "10000000-0000-4000-8000-00000000a915";
const key = "a".repeat(32);

const socketUpgrade = (() => (_context: Context) => new Response(null, { status: 426 })) as unknown as UpgradeWebSocket;

describe("collaboration capability HTTP routes", () => {
  let fixture: CollaborationTestDatabase;
  let runtime: Awaited<ReturnType<typeof createGatewayCollaboration>>;
  let app: Hono;
  let signer: CollaborationProofSigner;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    runtime = await createGatewayCollaboration({
      organizationMembershipSource: {
        async assertMembership({ actorId, organizationId: requested }) {
          return requested === organizationId && actorId !== outsiderId
            ? { member: true, expiresAt: new Date(Date.now() + 20_000).toISOString(), membershipEpoch: "1", aiSubmission: "owner_only" as const }
            : { member: false };
        },
      },
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: {
        runtimeId: collaborationIds.runtime,
        activeKeyId: "key-1",
        proofKeys: { "key-1": key },
        preflightSecret: "b".repeat(32),
        platformBaseUrl: "https://platform.internal",
        serviceToken: "c".repeat(32),
      },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const now = new Date().toISOString();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: ownerId, organization_id: organizationId,
      kind: "project", resource_id: "project_capability", parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
      revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime, authority_generation: 1,
      execution_generation: null, execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: scopeId, actor_id: ownerId, role: "owner", status: "accepted", organization_id: organizationId,
      invitation_id: null, invited_by: ownerId, accepted_at: now, expires_at: null, revision: 1,
      joined_at: now, updated_at: now, dispositioned_at: null,
    }).execute();
    signer = new CollaborationProofSigner({
      activeKeyId: "key-1", keys: { "key-1": key }, now: () => new Date(), createNonce: () => randomUUID().replaceAll("-", ""),
    });
    app = new Hono();
    runtime.register({ app, upgradeWebSocket: socketUpgrade });
  });

  afterEach(async () => {
    await runtime.shutdown();
    await fixture.destroy();
  });

  async function signed(input: { actorId: string; method: "GET" | "POST"; path: string; body?: unknown }): Promise<Response> {
    const bytes = input.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(input.body));
    const proof = signer.signHttp({
      actorId: input.actorId, ownerId, runtimeId: collaborationIds.runtime, scopeId,
      method: input.method, path: input.path, query: "", body: bytes,
    });
    return app.request(input.path, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
      },
      ...(input.body === undefined ? {} : { body: new TextDecoder().decode(bytes) }),
    });
  }

  it("creates a preset grant through the owner route and lists the exact contract projection", async () => {
    const path = `/api/collaboration/scopes/${scopeId}/grants`;
    const response = await signed({ actorId: ownerId, method: "POST", path, body: {
      clientRequestId: randomUUID(), expectedRevision: "1",
      audience: { kind: "member", actorId: memberId }, preset: "viewer",
    } });
    expect(response.status).toBe(201);
    const created = CollaborationGrantSchema.parse(await response.json());
    expect(created).toMatchObject({ scopeId, organizationId, audience: { kind: "member", actorId: memberId }, preset: "viewer", state: "pending" });
    const listed = await signed({ actorId: ownerId, method: "GET", path });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([created]);
    expect((await signed({ actorId: outsiderId, method: "GET", path })).status).toBe(404);
  });
});
