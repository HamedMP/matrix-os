import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("platform collaboration wiring", () => {
  let fixture: PlatformCollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("fails closed on incomplete environment configuration", () => {
    expect(loadPlatformCollaborationConfig({ MATRIX_COLLABORATION_ENABLED: "true" })).toBeNull();
    expect(loadPlatformCollaborationConfig({
      MATRIX_COLLABORATION_ENABLED: "true",
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toMatchObject({ activeKeyId: "key-1", enabledPurposes: ["events"] });
  });

  it("registers local and exact proxy routes after migrations", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ id: scopeId, role: "editor" }), {
      headers: { "content-type": "application/json" },
    }));
    const runtime = await createPlatformCollaboration({
      db: fixture.collaborationDb,
      config: {
        activeKeyId: "key-1",
        proofKeys: { "key-1": "a".repeat(32) },
        allowedOrigins: ["https://app.matrix-os.com"],
        enabledPurposes: ["events"],
      },
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async () => null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveRuntime: async (runtimeId) => ({
        runtimeId,
        ownerId: platformCollaborationActors.owner,
        baseUrl: "https://runtime.internal",
      }),
      fetchImpl: upstream,
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
    await runtime.repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_test",
    });
    const app = new Hono();
    runtime.register(app);
    const response = await app.request(`/api/collaboration/scopes/${scopeId}`, {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: scopeId, role: "editor" });
    expect(upstream).toHaveBeenCalledOnce();
    const [, init] = upstream.mock.calls[0]!;
    expect(new Headers(init?.headers).has("x-matrix-collaboration-proof")).toBe(true);
    await runtime.shutdown();
  });
});
