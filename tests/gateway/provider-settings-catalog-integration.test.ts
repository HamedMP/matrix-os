import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";

it("keeps Settings read negotiation separate from the immutable Chat selection argument", async () => {
  const principal = { userId: "owner", source: "jwt" as const };
  const getCatalog = vi.fn(async () => ({ revision: "fixture", drivers: [], instances: [] }));
  const refresh = vi.fn(getCatalog);
  const app = new Hono().route("/", createChatProviderRoutes({ catalog: { getCatalog, refresh }, getPrincipal: () => principal }));
  expect((await app.request("/api/chat-providers?includeSettingsSetupActions=true&includeFundingState=true")).status).toBe(200);
  expect(getCatalog).toHaveBeenCalledWith(principal, undefined, { includeSettingsSetupActions: true });
  getCatalog.mockClear();
  expect((await app.request("/api/chat-providers")).status).toBe(200);
  expect(getCatalog).toHaveBeenCalledWith(principal);
});
