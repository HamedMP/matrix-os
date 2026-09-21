/** T090 retirement gates; keep RED until CLI and UI direct consumers are integrated. */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPlatformCollaborationRoutes } from "../../packages/platform/src/collaboration/routes.js";
import { isCollaborationWebSocketCandidate, isCollaborationWebSocketPath } from "../../packages/platform/src/collaboration/websocket.js";
import { parseRelaySocketPath } from "../../packages/platform/src/collaboration/relay.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";

function routes() {
  const proxyForward = vi.fn(async () => new Response("legacy owner content", { status: 200 }));
  const relayForward = vi.fn(async () => new Response("direct owner content", { status: 200 }));
  const issueTicket = vi.fn(async () => ({ ticket: "c".repeat(43), expiresAt: "2026-09-21T12:00:30.000Z" }));
  const app = new Hono();
  app.route("/", createPlatformCollaborationRoutes({
    repository: {} as never, signer: {} as never,
    sockets: { issueTicket } as never,
    proxy: { forward: proxyForward } as never,
    relay: { forward: relayForward } as never,
    resolveActor: async () => "user_owner",
    authenticateRuntime: async () => null,
    resolveParticipant: async () => null,
    resolveInvitationIdentifier: async () => null,
  }));
  return { app, proxyForward, relayForward, issueTicket };
}

describe("T090 legacy collaboration serving retirement", () => {
  it("rejects an unsigned legacy content request without invoking the V1 proof proxy", async () => {
    const { app, proxyForward, relayForward } = routes();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/chat`);
    expect(response.status).toBe(404);
    expect(proxyForward).not.toHaveBeenCalled();
    expect(relayForward).not.toHaveBeenCalled();
  });

  it("preserves signed direct-session content forwarding through the transparent relay", async () => {
    const { app, proxyForward, relayForward } = routes();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/chat`, {
      headers: { "x-matrix-collaboration-session": sessionId },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("direct owner content");
    expect(relayForward).toHaveBeenCalledOnce();
    expect(proxyForward).not.toHaveBeenCalled();
  });

  it("retires the V1 connection-ticket endpoint without issuing an old credential", () => {
    const { app, issueTicket } = routes();
    expect(app.routes.some((route) => route.method === "POST"
      && route.path === "/api/collaboration/scopes/:scopeId/connection-tickets")).toBe(false);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it("rejects old platform-authorized terminal sockets while retaining the direct socket route", () => {
    const oldPath = `/ws/collaboration/scopes/${scopeId}/terminal?ticket=old`;
    const directPath = `/ws/collaboration/direct/scopes/${scopeId}/terminal?ticket=new`;
    expect(isCollaborationWebSocketCandidate(oldPath)).toBe(true);
    expect(isCollaborationWebSocketPath(oldPath)).toBe(false);
    expect(parseRelaySocketPath(directPath)).toMatchObject({ scopeId, purpose: "terminal" });
  });
});
