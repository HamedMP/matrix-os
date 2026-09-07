import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { CollaborationWebSocketAuthorizer } from "../../packages/platform/src/collaboration/websocket.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const inviteId = "30000000-0000-4000-8000-000000000001";
const runtimeSecret = "runtime-secret".repeat(3);

describe("platform collaboration routes", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let app: Hono;
  let hydrate: Parameters<typeof createPlatformCollaborationRoutes>[0]["hydrate"];

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    const signer = new CollaborationProofSigner({
      activeKeyId: "key-1",
      keys: { "key-1": "a".repeat(32) },
      now: () => now,
      createNonce: () => "b".repeat(32),
    });
    const sockets = new CollaborationWebSocketAuthorizer({
      repository,
      signer,
      allowedOrigins: ["https://app.matrix-os.com"],
      enabledPurposes: ["events"],
      now: () => now,
      createToken: () => "c".repeat(43),
    });
    hydrate = async ({ actorId, entry }) => entry.status === "invited" ? ({
      id: entry.invitationId,
      scopeId: entry.scopeId,
      owner: { actorId: entry.ownerId, displayName: "Owner" },
      target: { actorId, displayName: "Recipient" },
      scopeKind: "chat",
      role: "editor",
      status: "pending",
      expiresAt: "2026-09-14T12:00:00.000Z",
      revision: "1",
    }) : ({
      scope: {
        id: entry.scopeId, ownerId: entry.ownerId, kind: "chat", resourceId: "chat_shared",
        membershipMode: "direct", lifecycle: "shared", revision: "2", authEpoch: "2",
        authorityGeneration: String(entry.authorityGeneration), role: "editor",
        capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
      },
      chat: {
        id: "chat_shared", scopeId: entry.scopeId, title: "Shared Chat", lifecycle: "active",
        revision: "2", messageCount: "1",
      },
    });
    app = new Hono();
    app.route("/", createPlatformCollaborationRoutes({
      repository,
      signer,
      sockets,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async ({ runtimeId, bearerToken }) =>
        runtimeId === "runtime_owner" && bearerToken === runtimeSecret
          ? { runtimeId, ownerId: platformCollaborationActors.owner }
          : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: `Name ${actorId}` }),
      hydrate: (input) => hydrate(input),
      now: () => now,
    }));
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("accepts only an authenticated registered runtime's content-free directory event", async () => {
    const event = directoryEvent("invited");
    expect((await app.request("/internal/collaboration/directory", {
      method: "PUT",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
      },
      body: JSON.stringify(event),
    })).status).toBe(401);
    const accepted = await app.request("/internal/collaboration/directory", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${runtimeSecret}`,
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
      },
      body: JSON.stringify(event),
    });
    expect(accepted.status).toBe(204);
    expect(await repository.listForActor(platformCollaborationActors.recipientWithoutComputer))
      .toMatchObject([{ scopeId, status: "invited", invitationId: inviteId }]);
  });

  it("hydrates an invite inbox and accepted shared list for an actor without a computer", async () => {
    await repository.applyDirectoryEvent(directoryEvent("invited"));
    const inbox = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toMatchObject({ items: [{ status: "invited", resource: { id: inviteId } }] });
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), eventId: "20000000-0000-4000-8000-000000000002", metadataRevision: 2 });
    const shared = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ items: [{ status: "accepted", resource: { chat: { id: "chat_shared" } } }] });
  });

  it("keeps healthy discovery entries when one owner runtime cannot hydrate", async () => {
    await repository.applyDirectoryEvent(directoryEvent("invited"));
    const unavailableScopeId = "10000000-0000-4000-8000-000000000002";
    await repository.applyDirectoryEvent({
      ...directoryEvent("invited"),
      eventId: "20000000-0000-4000-8000-000000000002",
      scopeId: unavailableScopeId,
      metadataRevision: 2,
      recipients: [{
        actorId: platformCollaborationActors.recipientWithoutComputer,
        status: "invited",
        invitationId: "30000000-0000-4000-8000-000000000002",
      }],
    });
    const healthyHydrate = hydrate;
    hydrate = async (input) => {
      const { entry } = input;
      if (entry.scopeId === unavailableScopeId) throw new Error("owner runtime stopped");
      return healthyHydrate(input);
    };

    const response = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ scopeId, resource: { id: inviteId } }],
    });
  });

  it("issues an events-only ticket to an accepted current member", async () => {
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), metadataRevision: 2 });
    await repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_test",
    });
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/connection-tickets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": platformCollaborationActors.recipientWithoutComputer,
      },
      body: JSON.stringify({
        clientRequestId: "40000000-0000-4000-8000-000000000001",
        purpose: "events",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ticket: "c".repeat(43) });
  });

  it("serves bounded participant identity only to an authenticated runtime", async () => {
    const denied = await app.request(`/internal/collaboration/participants/${platformCollaborationActors.recipientWithoutComputer}`);
    expect(denied.status).toBe(401);
    const response = await app.request(
      `/internal/collaboration/participants/${platformCollaborationActors.recipientWithoutComputer}`,
      { headers: { authorization: `Bearer ${runtimeSecret}`, "x-matrix-runtime-id": "runtime_owner" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      displayName: `Name ${platformCollaborationActors.recipientWithoutComputer}`,
    });
  });

  it("serves a short-lived signed rollout policy only to an authenticated runtime", async () => {
    const denied = await app.request("/internal/collaboration/policy?milestone=m1");
    expect(denied.status).toBe(401);
    const response = await app.request("/internal/collaboration/policy?milestone=m1", {
      headers: { authorization: `Bearer ${runtimeSecret}`, "x-matrix-runtime-id": "runtime_owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: {
        milestone: "m1",
        revision: "0",
        mode: "off",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      },
      keyId: "key-1",
    });
  });
});

function directoryEvent(status: "invited" | "accepted") {
  return {
    eventId: "20000000-0000-4000-8000-000000000001",
    scopeId,
    runtimeId: "runtime_owner",
    ownerId: platformCollaborationActors.owner,
    kind: "chat" as const,
    authorityGeneration: 1,
    metadataRevision: 1,
    recipients: [{
      actorId: platformCollaborationActors.recipientWithoutComputer,
      status,
      invitationId: inviteId,
    }],
  };
}
