/** T090 retirement gates after the CLI and UI direct consumers were integrated. */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { isCollaborationWebSocketCandidate, parseRelaySocketPath } from "../../packages/platform/src/collaboration/relay.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";

function routes() {
  const relayForward = vi.fn(async () => new Response("direct owner content", { status: 200 }));
  const app = new Hono();
  app.route("/", createPlatformCollaborationRoutes({
    repository: {} as never,
    relay: { forward: relayForward } as never,
    resolveActor: async () => "user_owner",
    authenticateRuntime: async () => null,
    resolveParticipant: async () => null,
    resolveInvitationIdentifier: async () => null,
  }));
  return { app, relayForward };
}

describe("T090 legacy collaboration serving retirement", () => {
  it("rejects an unsigned legacy content request without invoking the V1 proof proxy", async () => {
    const { app, relayForward } = routes();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/chat`);
    expect(response.status).toBe(404);
    expect(relayForward).not.toHaveBeenCalled();
  });

  it("preserves signed direct-session content forwarding through the transparent relay", async () => {
    const { app, relayForward } = routes();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/chat`, {
      headers: { "x-matrix-collaboration-session": sessionId },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("direct owner content");
    expect(relayForward).toHaveBeenCalledOnce();
  });

  it("retires the V1 connection-ticket endpoint without issuing an old credential", async () => {
    const { app, relayForward } = routes();
    expect(app.routes.some((route) => route.method === "POST"
      && route.path === "/api/collaboration/scopes/:scopeId/connection-tickets")).toBe(false);
    expect((await app.request(`/api/collaboration/scopes/${scopeId}/connection-tickets`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request(`/api/collaboration/scopes/${scopeId}/connection-tickets`, {
      method: "POST", headers: { "x-matrix-collaboration-session": sessionId }, body: "{}",
    })).status).toBe(404);
    expect(relayForward).not.toHaveBeenCalled();
  });

  it("rejects old platform-authorized terminal sockets while retaining the direct socket route", () => {
    const oldPath = `/ws/collaboration/scopes/${scopeId}/terminal?ticket=old`;
    const directPath = `/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=new`;
    expect(isCollaborationWebSocketCandidate(oldPath)).toBe(true);
    expect(parseRelaySocketPath(oldPath)).toBeNull();
    expect(parseRelaySocketPath(directPath)).toMatchObject({ scopeId, purpose: "terminal" });
  });
});
