import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createInternalCollaborationRoutes } from "../../packages/platform/src/collaboration/internal-routes.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const runtimeId = "vps:10000000-0000-4000-8000-000000000001";
const token = "s".repeat(32);

describe("platform internal collaboration routes", () => {
  let fixture: PlatformCollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
  });

  afterEach(async () => destroyPlatformCollaborationTestDatabase(fixture));

  it("authenticates the authority runtime and persists content-free directory events", async () => {
    const app = createInternalCollaborationRoutes({
      repository: new PlatformCollaborationRepository(fixture.collaborationDb),
      authenticateRuntime: async (input) => input.runtimeId === runtimeId && input.bearerToken === token
        ? { runtimeId, ownerId: platformCollaborationActors.owner }
        : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: "Known participant" }),
    });
    const response = await app.request("/internal/collaboration/directory", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-matrix-runtime-id": runtimeId,
      },
      body: JSON.stringify({
        eventId: "20000000-0000-4000-8000-000000000001",
        scopeId: "10000000-0000-4000-8000-000000000001",
        runtimeId,
        ownerId: platformCollaborationActors.owner,
        kind: "chat",
        authorityGeneration: 1,
        metadataRevision: 1,
        recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "invited" }],
      }),
    });
    expect(response.status).toBe(204);
    expect(await fixture.collaborationDb.selectFrom("collaboration_directory").select("runtime_id").execute())
      .toEqual([{ runtime_id: runtimeId }]);
  });

  it("serves validated participant labels only to authenticated runtimes", async () => {
    const app = createInternalCollaborationRoutes({
      repository: new PlatformCollaborationRepository(fixture.collaborationDb),
      authenticateRuntime: async (input) => input.bearerToken === token
        ? { runtimeId: input.runtimeId, ownerId: platformCollaborationActors.owner }
        : null,
      resolveParticipant: async (actorId) => ({ actorId, displayName: "Nima Owner" }),
    });
    expect((await app.request(`/internal/collaboration/participants/${platformCollaborationActors.owner}`)).status)
      .toBe(401);
    const response = await app.request(`/internal/collaboration/participants/${platformCollaborationActors.owner}`, {
      headers: { authorization: `Bearer ${token}`, "x-matrix-runtime-id": runtimeId },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorId: platformCollaborationActors.owner, displayName: "Nima Owner" });
  });
});
