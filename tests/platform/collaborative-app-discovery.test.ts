import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-11-05T10:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";
const app = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  readinessId: "60000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: 1,
  state: "active" as const,
};

describe("collaborative app current-membership discovery", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let routes: Hono;
  const organizations = new Map<string, string[]>();

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    routes = new Hono();
    routes.route("/", createPlatformCollaborationRoutes({
      repository,
      resolveActor: async (context) => context.req.header("x-test-actor") ?? null,
      authenticateRuntime: async () => null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId === platformCollaborationActors.owner ? "Owner" : "Member" }),
      resolveInvitationIdentifier: async () => null,
      listOrganizationIds: async (actorId) => organizations.get(actorId) ?? [],
      now: () => now,
    }));
    organizations.set(platformCollaborationActors.recipientWithoutComputer, ["org_matrix_team"]);
    organizations.set("user_platform_guest", ["org_matrix_team"]);
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "app",
      organizationId: "org_matrix_team",
      audience: "current_membership",
      authorityGeneration: 1,
      metadataRevision: 1,
      app,
      recipients: [{ actorId: platformCollaborationActors.owner, status: "accepted" }],
    });
  });

  afterEach(async () => {
    organizations.clear();
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("lists typed exact-build app metadata for every current member without recipient rows", async () => {
    for (const actorId of [platformCollaborationActors.recipientWithoutComputer, "user_platform_guest"]) {
      const response = await routes.request("/api/collaboration/shared-apps?limit=10", {
        headers: { "x-test-actor": actorId },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [{
        scopeId,
        runtimeId: "runtime_owner",
        organizationId: "org_matrix_team",
        authorityGeneration: 1,
        appId: app.appId,
        catalogId: app.catalogId,
        readinessId: app.readinessId,
        registrationIncarnation: app.registrationIncarnation,
        buildId: app.buildId,
        shareRevision: "1",
        owner: { actorId: platformCollaborationActors.owner, displayName: "Owner" },
      }] });
    }
    const recipientRows = await fixture.collaborationDb.selectFrom("collaboration_user_index")
      .selectAll().where("actor_id", "!=", platformCollaborationActors.owner).execute();
    expect(recipientRows).toEqual([]);
  });

  it("omits outsiders, wrong organizations, stopped shares, and rejects malformed pagination", async () => {
    expect(await (await routes.request("/api/collaboration/shared-apps", {
      headers: { "x-test-actor": platformCollaborationActors.outsider },
    })).json()).toEqual({ items: [] });
    organizations.set(platformCollaborationActors.recipientWithoutComputer, ["org_other"]);
    expect(await (await routes.request("/api/collaboration/shared-apps", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).json()).toEqual({ items: [] });
    organizations.set(platformCollaborationActors.recipientWithoutComputer, ["org_matrix_team"]);
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000002",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "app",
      organizationId: "org_matrix_team",
      authorityGeneration: 1,
      metadataRevision: 2,
      app: { ...app, state: "stopped", shareRevision: 2 },
      recipients: [{ actorId: platformCollaborationActors.owner, status: "revoked" }],
    });
    expect(await (await routes.request("/api/collaboration/shared-apps", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).json()).toEqual({ items: [] });
    expect((await routes.request("/api/collaboration/shared-apps?limit=101", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).status).toBe(422);
    expect((await routes.request("/api/collaboration/shared-apps?cursor=not-json", {
      headers: { "x-test-actor": platformCollaborationActors.recipientWithoutComputer },
    })).status).toBe(422);
  });
});
