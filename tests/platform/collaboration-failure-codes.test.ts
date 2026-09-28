import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createPlatformCollaborationDirectRoutes } from "../../packages/platform/src/collaboration/direct-routes.js";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { createFailClosedPlatformCollaboration } from "../../packages/platform/src/collaboration/fail-closed.js";
import { CollaborationTicketIssuerError } from "../../packages/platform/src/collaboration/ticket-issuer.js";

const actorId = "user_failure_test";
const scopeId = "10000000-0000-4000-8000-000000000001";
const requestBody = JSON.stringify({ clientRequestId: "20000000-0000-4000-8000-000000000001", scopeId, purpose: "direct_session", proofPublicKey: "a".repeat(43) });

function direct(issuer: unknown) {
  return createPlatformCollaborationDirectRoutes({
    issuer: issuer as Parameters<typeof createPlatformCollaborationDirectRoutes>[0]["issuer"],
    endpoints: {} as Parameters<typeof createPlatformCollaborationDirectRoutes>[0]["endpoints"],
    controlStream: {} as Parameters<typeof createPlatformCollaborationDirectRoutes>[0]["controlStream"],
    relayOrigin: "https://relay.example",
    resolveActor: async () => actorId,
    authenticateRuntime: async () => null,
    resolveRelayHandle: async () => null,
  });
}

describe("platform collaboration failure codes", () => {
  it("marks a missing issuer unavailable, never a missing scope", async () => {
    const response = await direct(null).request("/api/collaboration/connections", { method: "POST", headers: { "content-type": "application/json" }, body: requestBody });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Collaboration unavailable", code: "unavailable" });
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["host_offline", 503, "host_offline"],
  ] as const)("keeps %s distinct", async (reason, status, code) => {
    const issuer = { issue: async () => { throw new CollaborationTicketIssuerError(reason, "private detail"); } };
    const response = await direct(issuer).request("/api/collaboration/connections", { method: "POST", headers: { "content-type": "application/json" }, body: requestBody });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  it("codes fail-closed platform routes and retired routes", async () => {
    const unavailable = new Hono();
    createFailClosedPlatformCollaboration({ reason: "signing_configuration_missing" }).register(unavailable);
    expect(await (await unavailable.request("/api/collaboration/shared")).json()).toMatchObject({ code: "unavailable" });

    const routes = createPlatformCollaborationRoutes({
      repository: {} as Parameters<typeof createPlatformCollaborationRoutes>[0]["repository"],
      resolveActor: async () => actorId, authenticateRuntime: async () => null,
      resolveParticipant: async () => null, resolveInvitationIdentifier: async () => null,
    });
    const retired = await routes.request(`/api/collaboration/scopes/${scopeId}/connection-tickets`, { method: "POST" });
    expect(retired.status).toBe(404);
    expect(await retired.json()).toMatchObject({ code: "not_found" });
  });
});
