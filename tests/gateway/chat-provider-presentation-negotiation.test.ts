import { describe, expect, it, vi } from "vitest";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

describe("Chat provider presentation negotiation", () => {
  const instance = { ...managedChatInstances(makeAiProviderSnapshot(), [])[0]!, catalogRevision: "revision-1" };
  const catalog: CanonicalProviderCatalog = { revision: "revision-1", drivers: [{ kind: "kernel", displayName: "Claude SDK",
    adapterVersion: "1.0.0", capabilityClass: "system_agent" }], instances: [instance] };
  const routes = createChatProviderRoutes({
    catalog: { getCatalog: vi.fn(async () => catalog), refresh: vi.fn(async () => catalog) },
    getPrincipal: () => ({ userId: "owner", source: "jwt" }),
  });

  it.each(["", "?includeConnectionLabels=true"])("keeps the new state out of strict older clients: %s", async query => {
    const response = await routes.request(`/api/chat-providers${query}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instances[0]).not.toHaveProperty("connectionState");
    expect(catalog.instances[0]).toHaveProperty("connectionState", "ready");
  });

  it("negotiates state and label independently without changing the execution identity", async () => {
    const response = await routes.request("/api/chat-providers?includeConnectionState=true");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instances[0]).toMatchObject({ id: "kernel_matrix_included", connectionState: "ready" });
    expect(body.instances[0]).not.toHaveProperty("connectionLabel");
  });

  it("negotiates both additions for current clients", async () => {
    const response = await routes.request("/api/chat-providers?includeConnectionLabels=true&includeConnectionState=true");
    expect(response.status).toBe(200);
    expect((await response.json()).instances[0]).toMatchObject({ connectionLabel: "Matrix AI", connectionState: "ready" });
  });

  it("rejects invalid state flags", async () => {
    const response = await routes.request("/api/chat-providers?includeConnectionState=yes");
    expect(response.status).toBe(400);
  });

  it.each([
    ["?includeConnectionState=true", "credit_required"],
    ["?includeConnectionState=true&includeFundingState=true", "credit_reserved"],
  ])("negotiates reserved-credit state without breaking existing negotiated clients: %s", async (query, expected) => {
    const held = { ...catalog, instances: [{ ...instance, availability: "unavailable" as const,
      connectionState: "credit_reserved" as const, defaultSelection: undefined,
      models: instance.models.map(model => ({ ...model, availability: "unavailable" as const })) }] };
    const server = createChatProviderRoutes({ catalog: { getCatalog: async () => held, refresh: async () => held },
      getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
    const response = await server.request(`/api/chat-providers${query}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instances[0]).toMatchObject({ connectionState: expected, availability: "unavailable",
      models: [{ availability: "unavailable" }] });
    expect(body.instances[0].defaultSelection).toBeUndefined();
    expect(held.instances[0]!.connectionState).toBe("credit_reserved");
  });
  it("rejects an invalid funding-state capability", async () => {
    expect((await routes.request("/api/chat-providers?includeFundingState=yes")).status).toBe(400);
  });
});
