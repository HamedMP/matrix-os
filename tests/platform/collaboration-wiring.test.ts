import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlatformCollaboration,
  loadPlatformCollaborationConfig,
} from "../../packages/platform/src/collaboration/wiring.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const directKeys = {
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "direct-key",
  MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "direct-key": Buffer.alloc(32, 1).toString("base64url") }),
};

describe("platform collaboration wiring", () => {
  let fixture: PlatformCollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("requires direct ticket keys and ignores V1 proof keys", () => {
    expect(loadPlatformCollaborationConfig({})).toBeNull();
    expect(loadPlatformCollaborationConfig({
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "legacy-key",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "legacy-key": "a".repeat(32) }),
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toBeNull();
    expect(loadPlatformCollaborationConfig({
      ...directKeys,
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toMatchObject({
      ticketKeyring: { activeKeyId: "direct-key" },
      allowedOrigins: ["https://app.matrix-os.com"],
    });
  });

  it("registers only metadata and direct serving, not the V1 content proxy", async () => {
    const runtime = await createPlatformCollaboration({
      db: fixture.collaborationDb,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async () => null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
      now: () => new Date("2026-09-07T12:00:00.000Z"),
    });
    await runtime.repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    const app = new Hono();
    runtime.register(app);
    expect((await app.request(`/api/collaboration/scopes/${scopeId}/chat`, {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).status).toBe(404);
    const discovery = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ items: [{ scopeId, status: "accepted", kind: "chat" }] });
    await runtime.shutdown();
  });
});
