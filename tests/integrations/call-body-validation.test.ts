import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createIntegrationCallHandler } from "../../packages/gateway/src/integrations/call-handler.js";

it("rejects malformed integration calls without exposing schema issues or invoking a provider", async () => {
  const getOrCreateExternalId = vi.fn();
  const handler = createIntegrationCallHandler({ db: {} as never, pipedream: {} as never,
    requireUser: async () => "owner", getOrCreateExternalId, consumePendingLabel: vi.fn(),
    applyExplicitReconnectLabel: vi.fn(), resolveAccountEmail: vi.fn(), emit: vi.fn() });
  const app = new Hono().post("/call", handler);
  const response = await app.request("/call", {method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({service: [], action: 12, params: "private"})});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error: "Invalid request body"});
  expect(getOrCreateExternalId).not.toHaveBeenCalled();
});
