import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import {
  enableOwnerSharedAi,
  registerOwnerCollaborationRoutes,
} from "../../packages/gateway/src/startup/collaboration.js";

const upgradeWebSocket = (() => async () => new Response(null, { status: 500 })) as unknown as UpgradeWebSocket;

describe("owner collaboration startup registration", () => {
  it("registers the ready runtime with the original app and WebSocket upgrader", async () => {
    const app = new Hono();
    const register = vi.fn(({ app: target }: { app: Hono }) => {
      target.get("/api/collaboration/startup-probe", (c) => c.json({ ready: true }));
    });
    registerOwnerCollaborationRoutes({
      app,
      upgradeWebSocket,
      gatewayCollaboration: { register } as never,
      collaborationFailClosedReason: null,
    });
    expect(register).toHaveBeenCalledWith({ app, upgradeWebSocket });
    expect((await app.request("/api/collaboration/startup-probe")).status).toBe(200);
  });

  it("registers fail-closed HTTP and WebSocket routes after owner database failure", async () => {
    const app = new Hono();
    registerOwnerCollaborationRoutes({
      app,
      upgradeWebSocket,
      gatewayCollaboration: null,
      collaborationFailClosedReason: "owner_database_missing",
    });
    for (const path of [
      "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001",
      "/ws/collaboration/scopes/10000000-0000-4000-8000-000000000001/events",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Collaboration unavailable" });
    }
  });

  it("enables shared AI once with the canonical runtime inputs and reports availability", async () => {
    const enableSharedAi = vi.fn(async () => ({ available: true }));
    const log = vi.fn();
    const input = {
      orchestrator: { id: "orchestrator" },
      homePath: "/owner/home",
      providerCatalog: { id: "catalog" },
      codingProviders: { id: "coding" },
      fundedCredentialProvider: { id: "funding" },
    };
    await enableOwnerSharedAi({ gatewayCollaboration: { enableSharedAi } as never, input: input as never, log });
    expect(enableSharedAi).toHaveBeenCalledOnce();
    expect(enableSharedAi).toHaveBeenCalledWith(input);
    expect(log).toHaveBeenCalledWith("[collaboration] shared AI ready");
    await enableOwnerSharedAi({ gatewayCollaboration: null, input: input as never, log });
    expect(enableSharedAi).toHaveBeenCalledOnce();
  });
});
