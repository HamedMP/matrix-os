import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";

const emptySnapshot: AiProviderSnapshotV3 = {
  contractVersion: 3,
  revision: 0,
  refreshedAt: "2026-08-29T21:00:00.000Z",
  accessSources: [],
  accounts: [],
  drivers: [],
  instances: [],
  models: [],
  active: { providerInstanceId: null, accessSourceId: null, modelId: null },
};

describe("AI provider routes", () => {
  it("authenticates and returns the bounded canonical provider snapshot", async () => {
    const getSnapshot = vi.fn(async () => emptySnapshot);
    const getPrincipal = vi.fn(() => ({ userId: "owner_123" }));
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({
      service: { getSnapshot },
      getPrincipal,
    }));

    const response = await app.request("/api/ai/providers");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(AiProviderSnapshotV3Schema.parse(body)).toEqual(emptySnapshot);
    expect(getPrincipal).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledWith({ refresh: false });
  });

  it("supports an explicit bounded refresh and rejects unknown query values", async () => {
    const getSnapshot = vi.fn(async () => emptySnapshot);
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({
      service: { getSnapshot },
      getPrincipal: () => ({ userId: "owner_123" }),
    }));

    expect((await app.request("/api/ai/providers?refresh=true")).status).toBe(200);
    expect(getSnapshot).toHaveBeenLastCalledWith({ refresh: true });
    expect((await app.request("/api/ai/providers?refresh=yes")).status).toBe(400);
  });

  it("maps service failures to a provider-neutral response", async () => {
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({
      service: { getSnapshot: async () => { throw new Error("Anthropic sk-secret /opt/private"); } },
      getPrincipal: () => ({ userId: "owner_123" }),
    }));

    const response = await app.request("/api/ai/providers");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "AI provider status is unavailable" });
    expect(JSON.stringify(body)).not.toContain("Anthropic");
    expect(JSON.stringify(body)).not.toContain("/opt/private");
  });

  it("fails registration when a required dependency is absent", () => {
    expect(() => createAiProviderRoutes({
      service: undefined as never,
      getPrincipal: () => ({ userId: "owner_123" }),
    })).toThrow("AI provider service is required");
  });
});
