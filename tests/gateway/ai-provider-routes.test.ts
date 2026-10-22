import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { createAiProviderRoutes } from "../../packages/gateway/src/ai-providers/routes.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

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
  it.each([false, true])("negotiates rich funding reasons independently of native profiles: %s", async rich => {
    const held = makeAiProviderSnapshot();
    Object.assign(held.accessSources[0]!, { state: "unavailable", action: "retry", safeReason: "credit_reserved" });
    held.instances[0]!.readiness = { state: "unavailable", action: "retry", safeReason: "credit_reserved", checkedAt: null, staleAfter: null };
    held.instances[0]!.defaultModelId = null;
    const app = createAiProviderRoutes({ service: { getSnapshot: async () => held }, getPrincipal: () => ({ userId: "owner_123" }) });
    for (const native of [false, true]) {
      const response = await app.request(`/providers?includeNativeProfiles=${native}&includeFundingState=${rich}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.accessSources[0].safeReason).toBe(rich ? "credit_reserved" : "credit_required");
      expect(body.instances[0].readiness.safeReason).toBe(rich ? "credit_reserved" : "credit_required");
      expect(held.accessSources[0]!.safeReason).toBe("credit_reserved");
    }
    expect((await app.request("/providers?includeFundingState=yes")).status).toBe(400);
  });
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

  it("strips new native metadata for historical clients and exposes it only on explicit opt-in", async () => {
    const native = { profiles: [], failures: ["pi" as const] };
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({ service: { getSnapshot: async () => ({ ...emptySnapshot, nativeHarnessCatalog: native }) }, getPrincipal: () => ({ userId: "owner_123" }) }));
    expect(await (await app.request("/api/ai/providers")).json()).toEqual(emptySnapshot);
    const current = await (await app.request("/api/ai/providers?includeNativeProfiles=true")).json();
    expect(AiProviderSnapshotV3Schema.parse(current).nativeHarnessCatalog).toEqual(native);
    expect((await app.request("/api/ai/providers?includeNativeProfiles=yes")).status).toBe(400);
  });
  it("negotiates platform upstream truth for raw V3 readers", async () => {
    const upstreamPreference = { selectedUpstream: "aws_bedrock" as const,
      effectiveUpstream: "aws_bedrock" as const,
      effectiveBedrockModelIds: ["anthropic/claude-sonnet-5"], revision: 2,
      updatedAt: "2026-08-29T20:59:00.000Z", validThrough: "2026-09-30T00:00:00.000Z" };
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({ service: { getSnapshot: async () => ({
      ...emptySnapshot, upstreamPreference,
    }) }, getPrincipal: () => ({ userId: "owner_123" }),
      canAccessUpstreamPreference: () => true }));
    expect(await (await app.request("/api/ai/providers")).json()).not.toHaveProperty("upstreamPreference");
    expect(await (await app.request("/api/ai/providers?includeUpstreamPreference=true")).json())
      .toHaveProperty("upstreamPreference", upstreamPreference);
    expect((await app.request("/api/ai/providers?includeUpstreamPreference=yes")).status).toBe(400);
  });
  it("hides platform upstream truth from authenticated runtime guests", async () => {
    const upstreamPreference = { selectedUpstream: "aws_bedrock" as const,
      effectiveUpstream: "aws_bedrock" as const,
      effectiveBedrockModelIds: ["anthropic/claude-sonnet-5"], revision: 2,
      updatedAt: "2026-08-29T20:59:00.000Z", validThrough: "2026-09-30T00:00:00.000Z" };
    const app = createAiProviderRoutes({ service: { getSnapshot: async () => ({
      ...emptySnapshot, upstreamPreference,
    }) }, getPrincipal: () => ({ userId: "reviewer_123" }),
      canAccessUpstreamPreference: () => false });
    expect(await (await app.request("/providers?includeUpstreamPreference=true")).json())
      .not.toHaveProperty("upstreamPreference");
  });
  it("negotiates exact native driver observation fields without changing legacy V3 responses", async () => {
    const driver = { id: "hermes", displayName: "Hermes", kind: "cli" as const, installState: "installed" as const, health: "degraded" as const, capabilities: [], setupActions: [] };
    const nativeRouteObservation = { providerId: "anthropic", modelId: "claude-sonnet-5", credentialKind: "provider_profile" as const,
      localObservation: { state: "present_unverified" as const, checkedAt: "2026-08-30T10:00:00.000Z", staleAfter: "2026-08-30T10:00:05.000Z" } };
    const app = new Hono();
    app.route("/api/ai", createAiProviderRoutes({ service: { getSnapshot: async () => ({ ...emptySnapshot, drivers: [{ ...driver, nativeRouteObservation }] }) }, getPrincipal: () => ({ userId: "owner_123" }) }));
    const legacy = await (await app.request("/api/ai/providers")).json();
    expect(legacy.drivers).toEqual([driver]);
    const modern = await (await app.request("/api/ai/providers?includeNativeProfiles=true")).json();
    expect(AiProviderSnapshotV3Schema.parse(modern).drivers[0]?.nativeRouteObservation).toEqual(nativeRouteObservation);
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
