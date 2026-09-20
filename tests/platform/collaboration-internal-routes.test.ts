import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      resolveInvitationIdentifier: async () => null,
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
      resolveInvitationIdentifier: async () => null,
    });
    expect((await app.request(`/internal/collaboration/participants/${platformCollaborationActors.owner}`)).status)
      .toBe(401);
    const response = await app.request(`/internal/collaboration/participants/${platformCollaborationActors.owner}`, {
      headers: { authorization: `Bearer ${token}`, "x-matrix-runtime-id": runtimeId },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorId: platformCollaborationActors.owner, displayName: "Nima Owner" });
  });

  it("resolves invitation identifiers only for authenticated owner runtimes and fails generically", async () => {
    const resolveInvitationIdentifier = vi.fn(async (identifier: string) => identifier === "nimanaderi"
      ? { actorId: platformCollaborationActors.recipientWithoutComputer, displayName: "Nima Naderi" }
      : null);
    const app = createInternalCollaborationRoutes({
      repository: new PlatformCollaborationRepository(fixture.collaborationDb),
      authenticateRuntime: async (input) => input.bearerToken === token
        ? { runtimeId: input.runtimeId, ownerId: platformCollaborationActors.owner }
        : null,
      resolveParticipant: async () => null,
      resolveInvitationIdentifier,
    });
    const request = (identifier: string, authenticated = true) => app.request(
      "/internal/collaboration/participants/resolve",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${token}`, "x-matrix-runtime-id": runtimeId } : {}),
        },
        body: JSON.stringify({ identifier, organizationId: "org_matrix_team" }),
      },
    );
    expect((await request("nimanaderi", false)).status).toBe(401);
    expect(resolveInvitationIdentifier).not.toHaveBeenCalled();

    const resolved = await request("nimanaderi");
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      displayName: "Nima Naderi",
    });

    const unknown = await request("missing-person");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Invitation target unavailable" });
  });

  it("rate limits invitation resolution per authenticated owner runtime", async () => {
    const app = createInternalCollaborationRoutes({
      repository: new PlatformCollaborationRepository(fixture.collaborationDb),
      authenticateRuntime: async (input) => ({ runtimeId: input.runtimeId, ownerId: platformCollaborationActors.owner }),
      resolveParticipant: async () => null,
      resolveInvitationIdentifier: async () => null,
    });
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await app.request("/internal/collaboration/participants/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-matrix-runtime-id": runtimeId,
        },
        body: JSON.stringify({ identifier: `person-${index}`, organizationId: "org_matrix_team" }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses[10]).toBe(429);
  });
});
