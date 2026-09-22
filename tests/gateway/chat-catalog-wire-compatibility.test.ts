import { describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

function fixture() {
  const catalog = CanonicalProviderCatalogSchema.parse({ revision: "revision",
    drivers: [{ kind: "kernel", displayName: "Claude SDK", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
    instances: managedChatInstances(makeAiProviderSnapshot(), []).map((instance) => ({ ...instance, catalogRevision: "revision" })) });
  const service = { getCatalog: vi.fn(async () => catalog), refresh: vi.fn(async () => catalog) };
  const routes = createChatProviderRoutes({ catalog: service, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
  return { catalog, service, routes };
}
describe("Chat catalog connection label wire negotiation", () => {
  it.each(["", "?refresh=true", "?includeConnectionLabels=false"])("keeps strict legacy consumers compatible for %s", async (query) => {
    const { catalog, service, routes } = fixture();
    const response = await routes.request(`/api/chat-providers${query}`);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.instances[0]).not.toHaveProperty("connectionLabel");
    expect(result.revision).toBe(catalog.revision);
    expect(catalog.instances[0]).toHaveProperty("connectionLabel", "Matrix AI");
    expect(query.includes("refresh=true") ? service.refresh : service.getCatalog).toHaveBeenCalledOnce();
  });
  it.each(["?includeConnectionLabels=true", "?refresh=true&includeConnectionLabels=true"])("includes labels only with explicit opt-in %s", async (query) => {
    const { routes, catalog } = fixture();
    expect(await (await routes.request(`/api/chat-providers${query}`)).json()).toEqual(catalog);
  });
  it.each(["yes", "TRUE", "x".repeat(512)])("rejects invalid negotiation value %s without reading provider state", async (flag) => {
    const { routes, service } = fixture();
    expect((await routes.request(`/api/chat-providers?includeConnectionLabels=${flag}`)).status).toBe(400);
    expect(service.getCatalog).not.toHaveBeenCalled();
    expect(service.refresh).not.toHaveBeenCalled();
  });
});
