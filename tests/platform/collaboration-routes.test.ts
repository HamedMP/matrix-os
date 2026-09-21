import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const inviteId = "30000000-0000-4000-8000-000000000001";
const organizationGrantId = "70000000-0000-4000-8000-000000000001";
const runtimeSecret = "runtime-secret".repeat(3);

describe("platform collaboration routes", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let app: Hono;
  let organizationIds: string[];
  let resolveInvitationIdentifier: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    organizationIds = [];
    resolveInvitationIdentifier = vi.fn(async (identifier: string) => identifier === "nimanaderi"
      ? { actorId: platformCollaborationActors.recipientWithoutComputer, displayName: "Recipient" }
      : null);
    app = new Hono();
    app.route("/", createPlatformCollaborationRoutes({
      repository,
      resolveActor: async (c) => c.req.header("x-test-actor") ?? null,
      authenticateRuntime: async ({ runtimeId, bearerToken }) =>
        runtimeId === "runtime_owner" && bearerToken === runtimeSecret
          ? { runtimeId, ownerId: platformCollaborationActors.owner }
          : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: `Name ${actorId}` }),
      resolveInvitationIdentifier,
      listOrganizationIds: async () => organizationIds,
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

  it("returns metadata-only discovery items and never fetches resource content from a home", async () => {
    await repository.applyDirectoryEvent({ ...directoryEvent("invited"), organizationId: "org_1" });
    const inbox = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(inbox.status).toBe(200);
    const inboxPage = await inbox.json() as { items: Array<Record<string, unknown>> };
    expect(inboxPage.items).toEqual([{
      scopeId, runtimeId: "runtime_owner", ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1,
      status: "invited", invitationId: inviteId, organizationId: "org_1",
    }]);
    expect(inboxPage.items[0]).not.toHaveProperty("resource");
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), organizationId: "org_1", eventId: "20000000-0000-4000-8000-000000000002", metadataRevision: 2 });
    const shared = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(shared.status).toBe(200);
    const sharedPage = await shared.json() as { items: Array<Record<string, unknown>> };
    expect(sharedPage.items).toEqual([{
      scopeId, runtimeId: "runtime_owner", ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1,
      status: "accepted", organizationId: "org_1",
    }]);
  });

  it("resolves an exact pending invitation to scope metadata only for its indexed actor", async () => {
    await repository.applyDirectoryEvent({ ...directoryEvent("invited"), organizationId: "org_1" });
    const path = `/api/collaboration/invitations/${inviteId}/location`;
    const recipient = await app.request(path, { headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer } });
    expect(recipient.status).toBe(200);
    expect(await recipient.json()).toEqual({ scopeId });
    expect(recipient.headers.get("cache-control")).toBe("private, no-store");
    const outsider = await app.request(path, { headers: { "x-test-actor": platformCollaborationActors.owner } });
    expect(outsider.status).toBe(404);
    const unknown = await app.request(`/api/collaboration/invitations/30000000-0000-4000-8000-000000000099/location`,
      { headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer } });
    expect(unknown.status).toBe(404);
    expect((await outsider.json())).toEqual(await unknown.json());
    expect((await app.request(path)).status).toBe(401);
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), organizationId: "org_1",
      eventId: "20000000-0000-4000-8000-000000000002", metadataRevision: 2 });
    expect((await app.request(path, { headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer } })).status).toBe(404);
  });

  it("lists organization-wide shares as pending only for current members who have not opened them", async () => {
    const orgScopeId = "10000000-0000-4000-8000-000000000077";
    await repository.applyDirectoryEvent({
      ...directoryEvent("accepted"), eventId: "20000000-0000-4000-8000-000000000077", scopeId: orgScopeId,
      organizationId: "org_1", audience: "organization", organizationGrantId, recipients: [],
    });
    await repository.applyDirectoryEvent({
      ...directoryEvent("accepted"), eventId: "20000000-0000-4000-8000-000000000079",
      scopeId: "10000000-0000-4000-8000-000000000079",
      organizationId: "org_1", audience: "organization", recipients: [],
    });
    organizationIds = ["org_1"];
    const member = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(await member.json()).toEqual({ items: [{
      scopeId: orgScopeId, runtimeId: "runtime_owner", ownerId: platformCollaborationActors.owner, kind: "chat", authorityGeneration: 1,
      status: "organization_pending", organizationId: "org_1", grantId: organizationGrantId,
    }] });
    // The owner is never pending on their own share.
    const owner = await app.request("/api/collaboration/inbox", { headers: { "x-test-actor": platformCollaborationActors.owner } });
    expect(await owner.json()).toEqual({ items: [] });
    // Outside the organization nothing is listed, whatever the audience flag says.
    organizationIds = ["org_other"];
    const outsider = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(await outsider.json()).toEqual({ items: [] });
    // Once the member has an index row (opened, accepted or declined) the item stops being pending.
    organizationIds = ["org_1"];
    await repository.applyDirectoryEvent({
      ...directoryEvent("accepted"), eventId: "20000000-0000-4000-8000-000000000078", scopeId: orgScopeId,
      organizationId: "org_1", audience: "organization", organizationGrantId, metadataRevision: 2,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    const opened = await app.request("/api/collaboration/inbox", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(await opened.json()).toEqual({ items: [] });
    const shared = await app.request("/api/collaboration/shared", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(await shared.json()).toMatchObject({ items: [{ scopeId: orgScopeId, status: "accepted" }] });
  });

  it("paginates organization-pending shares after ordinary invitations without losing any", async () => {
    await repository.applyDirectoryEvent(directoryEvent("invited"));
    for (const suffix of ["071", "072", "073"]) {
      await repository.applyDirectoryEvent({
        ...directoryEvent("accepted"), scopeId: `10000000-0000-4000-8000-000000000${suffix}`,
        eventId: `20000000-0000-4000-8000-000000000${suffix}`,
        organizationId: "org_1", audience: "organization", recipients: [],
        organizationGrantId: `70000000-0000-4000-8000-000000000${suffix}`,
      });
    }
    organizationIds = ["org_1"];
    const seen: Array<{ scopeId: string; status: string }> = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const response = await app.request(`/api/collaboration/inbox?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        { headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer } });
      expect(response.status).toBe(200);
      const page = await response.json() as { items: Array<{ scopeId: string; status: string }>; nextCursor?: string };
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((item) => item.scopeId)).size).toBe(4);
    expect(seen.filter((item) => item.status === "organization_pending")).toHaveLength(3);
  });

  it("returns opaque actor/status-bound discovery pages and rejects malformed cursors", async () => {
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), metadataRevision: 2 });
    await repository.applyDirectoryEvent({
      ...directoryEvent("accepted"),
      eventId: "20000000-0000-4000-8000-000000000099",
      scopeId: "10000000-0000-4000-8000-000000000099",
      metadataRevision: 2,
      recipients: [{
        actorId: platformCollaborationActors.recipientWithoutComputer,
        status: "accepted",
      }],
    });
    const first = await app.request("/api/collaboration/shared?limit=1", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(first.status).toBe(200);
    const firstPage = await first.json() as { items: Array<{ scopeId: string }>; nextCursor: string };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await app.request(`/api/collaboration/shared?limit=1&cursor=${firstPage.nextCursor}`, {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    });
    expect(second.status).toBe(200);
    expect((await second.json() as { items: Array<{ scopeId: string }> }).items).toHaveLength(1);
    expect((await app.request("/api/collaboration/shared?cursor=not-a-cursor", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).status).toBe(422);
  });

  it("does not issue a V1 connection ticket to an accepted current member", async () => {
    await repository.applyDirectoryEvent({ ...directoryEvent("accepted"), metadataRevision: 2 });
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
    expect(response.status).toBe(404);
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

  it("resolves an invitation identifier only for an authenticated owner runtime", async () => {
    const denied = await app.request("/internal/collaboration/participants/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "nimanaderi", organizationId: "org_matrix_team" }),
    });
    expect(denied.status).toBe(401);
    expect(resolveInvitationIdentifier).not.toHaveBeenCalled();

    const response = await app.request("/internal/collaboration/participants/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeSecret}`,
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
      },
      body: JSON.stringify({ identifier: "nimanaderi", organizationId: "org_matrix_team" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      displayName: "Recipient",
    });
    expect(resolveInvitationIdentifier).toHaveBeenCalledWith("nimanaderi", "org_matrix_team");

    for (let index = 0; index < 9; index += 1) {
      const unresolved = await app.request("/internal/collaboration/participants/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeSecret}`,
          "content-type": "application/json",
          "x-matrix-runtime-id": "runtime_owner",
        },
        body: JSON.stringify({ identifier: `unknown-${index}`, organizationId: "org_matrix_team" }),
      });
      expect(unresolved.status).toBe(404);
      expect(await unresolved.json()).toEqual({ error: "Invitation target unavailable" });
    }
    const limited = await app.request("/internal/collaboration/participants/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeSecret}`,
        "content-type": "application/json",
        "x-matrix-runtime-id": "runtime_owner",
      },
      body: JSON.stringify({ identifier: "unknown-limited", organizationId: "org_matrix_team" }),
    });
    expect(limited.status).toBe(429);
    expect(resolveInvitationIdentifier).toHaveBeenCalledTimes(10);
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
