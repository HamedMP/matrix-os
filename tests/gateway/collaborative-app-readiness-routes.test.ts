import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerCollaborativeAppReadinessRoutes } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-routes.js";
import { CollaborativeAppBuildResolver } from "../../packages/gateway/src/collaboration/collaborative-app-build-resolver.js";
import { appRegistryIncarnation } from "../../packages/gateway/src/collaboration/app-incarnation.js";
import {
  markAuthContextReady,
  markVerifiedRuntimeBearer,
  setPlatformVerifiedPrincipal,
} from "../../packages/gateway/src/request-principal.js";

const appId = "team-tracker";
const build = {
  appId,
  catalogId: "50000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

const blocked = {
  id: "60000000-0000-4000-8000-000000000001",
  ownerId: "user_owner",
  build,
  artifactRef: `objects/${build.buildId}`,
  status: "blocked" as const,
  gateResults: [{
    code: "declaration" as const,
    status: "blocked" as const,
    action: "Declare collaborative capability.",
  }],
  verifiedAt: null,
  invalidatedAt: null,
  invalidationReason: null,
  verifierVersion: "collaborative-app-v1",
  revision: 2,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:01:00.000Z",
};

function setup(overrides: Record<string, unknown> = {}) {
  const routes = new Hono();
  routes.use("*", async (context, next) => {
    markAuthContextReady(context);
    const principal = context.req.header("x-test-principal");
    if (principal) {
      markVerifiedRuntimeBearer(context);
      setPlatformVerifiedPrincipal(context, principal);
    }
    await next();
  });
  const dependencies = {
    ownerId: "user_owner",
    repository: {
      getCurrent: vi.fn(async () => blocked),
    },
    evaluator: { check: vi.fn(async () => blocked) },
    resolveCurrentBuild: vi.fn(async () => ({ build, artifactRef: `objects/${build.buildId}` })),
    registrationIncarnation: vi.fn(async () => build.registrationIncarnation),
    requireOrganizationMembership: vi.fn(async () => undefined),
    rateLimiter: { check: vi.fn(() => true) },
    ...overrides,
  };
  registerCollaborativeAppReadinessRoutes(routes, dependencies as never);
  return { routes, dependencies };
}

const checkBody = {
  clientRequestId: "70000000-0000-4000-8000-000000000001",
  expectedRegistrationIncarnation: build.registrationIncarnation,
  organizationId: "org_matrix_team",
};

describe("collaborative app readiness routes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns only the owner current exact-build projection with private no-store caching", async () => {
    const { routes, dependencies } = setup();
    const response = await routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_owner" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ readinessId: blocked.id, status: "blocked", revision: "2", build });
    expect(dependencies.repository.getCurrent).toHaveBeenCalledWith({
      ownerId: "user_owner", catalogId: build.catalogId, buildId: build.buildId,
    });
    expect(body).not.toHaveProperty("artifactRef");
    expect(body).not.toHaveProperty("ownerId");

    for (const record of [{
      ...blocked,
      status: "ready" as const,
      gateResults: [{ code: "cleanup" as const, status: "passed" as const }],
      verifiedAt: "2026-11-05T10:01:00.000Z",
    }, {
      ...blocked,
      status: "stale" as const,
      invalidatedAt: "2026-11-05T10:02:00.000Z",
    }]) {
      const projected = setup({ repository: { getCurrent: async () => record } });
      const projectedResponse = await projected.routes.request(`/api/collaboration/apps/${appId}/readiness`, {
        headers: { "x-test-principal": "user_owner" },
      });
      expect(await projectedResponse.json()).toMatchObject({ status: record.status });
    }
  });

  it("returns an interrupted check as stale when drift precedes its first gate result", async () => {
    const interrupted = setup({ repository: { getCurrent: async () => ({
      ...blocked,
      status: "stale",
      gateResults: [],
      verifiedAt: null,
      invalidatedAt: "2026-11-05T10:02:00.000Z",
    }) } });
    const response = await interrupted.routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "stale", checks: [] });
  });

  it("bounds expensive readiness reads before resolving the current build", async () => {
    const limited = setup({ readRateLimiter: { check: () => false } });
    const response = await limited.routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_owner" },
    });
    expect(response.status).toBe(429);
    expect(limited.dependencies.resolveCurrentBuild).not.toHaveBeenCalled();
  });

  it("returns the current registration incarnation so an unchecked exact build can be checked", async () => {
    const { routes, dependencies } = setup({
      repository: { getCurrent: async () => null },
      resolveCurrentBuild: vi.fn(async () => null),
    });
    const response = await routes.request(`/api/collaboration/apps/${appId}/readiness/registration`, {
      headers: { "x-test-principal": "user_owner" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ registrationIncarnation: build.registrationIncarnation });
    expect(dependencies.resolveCurrentBuild).not.toHaveBeenCalled();
  });

  it("rejects missing and foreign principals before resolving app state", async () => {
    const { routes, dependencies } = setup();
    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness`)).status).toBe(401);
    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_other" },
    })).status).toBe(403);
    expect(dependencies.resolveCurrentBuild).not.toHaveBeenCalled();
    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness/registration`)).status).toBe(401);
    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness/registration`, {
      headers: { "x-test-principal": "user_other" },
    })).status).toBe(403);
    expect(dependencies.registrationIncarnation).not.toHaveBeenCalled();
  });

  it("requires the real owner bearer middleware before accepting configured-owner fallback", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const dependencies = setup().dependencies;
    const routes = new Hono();
    routes.use("*", authMiddleware("owner-gateway-token"));
    registerCollaborativeAppReadinessRoutes(routes, dependencies as never);

    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness`)).status).toBe(401);
    expect(dependencies.resolveCurrentBuild).not.toHaveBeenCalled();

    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { authorization: "Bearer owner-gateway-token" },
    })).status).toBe(200);
    const registration = await routes.request(`/api/collaboration/apps/${appId}/readiness/registration`, {
      headers: { authorization: "Bearer owner-gateway-token" },
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({ registrationIncarnation: build.registrationIncarnation });
    expect((await routes.request(`/api/collaboration/apps/${appId}/readiness/registration`, {
      headers: { authorization: "Bearer incorrect-token" },
    })).status).toBe(401);
  });

  it("checks membership and persists the capability result for the exact incarnation", async () => {
    const { routes, dependencies } = setup();
    const response = await routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify(checkBody),
    });
    expect(response.status).toBe(200);
    expect(dependencies.requireOrganizationMembership).toHaveBeenCalledWith("user_owner", "org_matrix_team");
    expect(dependencies.evaluator.check).toHaveBeenCalledWith({
      ownerId: "user_owner",
      organizationId: "org_matrix_team",
      build,
      artifactRef: `objects/${build.buildId}`,
      declaration: null,
    });
    expect(await response.json()).toMatchObject({ status: "blocked" });
  });

  it("bounds path, body, exact incarnation, and per-owner attempts before evaluation", async () => {
    const limited = setup({ rateLimiter: { check: () => false } });
    expect((await limited.routes.request("/api/collaboration/apps/bad!/readiness", {
      headers: { "x-test-principal": "user_owner" },
    })).status).toBe(400);
    expect((await limited.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify(checkBody),
    })).status).toBe(429);

    const normal = setup();
    expect((await normal.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify({ ...checkBody, expectedRegistrationIncarnation: "f".repeat(64) }),
    })).status).toBe(409);
    expect((await normal.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify({ ...checkBody, unexpected: true }),
    })).status).toBe(400);
    expect((await normal.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify({ padding: "x".repeat(100_000) }),
    })).status).toBe(413);
    expect((await normal.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "100000",
        "x-test-principal": "user_owner",
      },
      body: "{}",
    })).status).toBe(413);
    expect((await normal.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: "{",
    })).status).toBe(400);
  });

  it("returns not found or null without projecting stale catalog/build state", async () => {
    const missing = setup({ resolveCurrentBuild: async () => null, registrationIncarnation: async () => null });
    expect((await missing.routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_owner" },
    })).status).toBe(404);
    expect((await missing.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify(checkBody),
    })).status).toBe(404);

    for (const repository of [
      { getCurrent: async () => null },
      { getCurrent: async () => ({ ...blocked, build: { ...build, buildId: "f".repeat(64) } }) },
    ]) {
      const state = setup({ repository });
      const response = await state.routes.request(`/api/collaboration/apps/${appId}/readiness`, {
        headers: { "x-test-principal": "user_owner" },
      });
      expect(await response.json()).toBeNull();
    }
  });

  // Outcome: an owned app that was never checked reads as "not checked yet" instead of an error.
  // Fault detected: the GET mapped the resolver's "no catalog entry yet" null to 404, which
  // every client renders as "App collaboration readiness is unavailable."
  it("reads an owned app without a catalog entry as not checked, without registering it", async () => {
    const registration = { slug: appId, created_at: "2026-11-05T10:00:00.000Z", tables: {} };
    const resolverFor = (
      appRegistry: { get(appId: string): Promise<unknown> },
      liveCatalog: unknown = null,
    ) => {
      const catalog = { getLiveByPath: vi.fn(async () => liveCatalog), register: vi.fn() };
      const resolver = new CollaborativeAppBuildResolver({
        homePath: "/nonexistent-matrix-home",
        ownerId: "user_owner",
        appRegistry: appRegistry as never,
        catalog: catalog as never,
        readiness: { invalidateDriftedBuilds: async () => 0 },
        store: {} as never,
      });
      const state = setup({
        resolveCurrentBuild: (ownerId: string, id: string, options: { ensureCatalog: boolean }) =>
          resolver.resolve(ownerId, id, options),
        registrationIncarnation: (ownerId: string, id: string) => resolver.registrationIncarnation(ownerId, id),
      });
      return { ...state, catalog };
    };
    const read = (routes: Hono) => routes.request(`/api/collaboration/apps/${appId}/readiness`, {
      headers: { "x-test-principal": "user_owner" },
    });

    const unchecked = resolverFor({ get: async () => registration });
    const uncheckedResponse = await read(unchecked.routes);
    expect(uncheckedResponse.status).toBe(200);
    expect(await uncheckedResponse.json()).toBeNull();
    expect(unchecked.catalog.register).not.toHaveBeenCalled();
    expect(unchecked.dependencies.repository.getCurrent).not.toHaveBeenCalled();

    const replaced = resolverFor({ get: async () => registration }, {
      id: build.catalogId, ownerId: "user_owner", projectId: null, kind: "app", path: appId,
      parentId: null, incarnation: "f".repeat(64), revision: 0,
      updatedAt: registration.created_at, deletedAt: null,
    });
    expect(appRegistryIncarnation(registration as never)).not.toBe("f".repeat(64));
    const replacedResponse = await read(replaced.routes);
    expect(replacedResponse.status).toBe(200);
    expect(await replacedResponse.json()).toBeNull();
    expect(replaced.catalog.register).not.toHaveBeenCalled();

    for (const appRegistry of [
      { get: async () => null },
      { get: async () => ({ ...registration, slug: "other-app" }) },
    ]) {
      const missing = resolverFor(appRegistry);
      const response = await read(missing.routes);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "App not found", code: "not_found" });
      expect(missing.catalog.register).not.toHaveBeenCalled();
    }

    const failing = setup({
      resolveCurrentBuild: async () => null,
      registrationIncarnation: async () => { throw new Error("postgres password=secret"); },
    });
    const failingResponse = await read(failing.routes);
    expect(failingResponse.status).toBe(503);
    expect(await failingResponse.json()).toEqual({ error: "App readiness is unavailable", code: "unavailable" });
  });

  it("uses a bounded default limiter and maps unavailable auth context safely", async () => {
    const bounded = setup({ rateLimiter: undefined });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await bounded.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
        body: JSON.stringify(checkBody),
      })).status).toBe(200);
    }
    expect((await bounded.routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
      body: JSON.stringify(checkBody),
    })).status).toBe(429);

    const unavailable = new Hono();
    registerCollaborativeAppReadinessRoutes(unavailable, setup().dependencies as never);
    const response = await unavailable.request(`/api/collaboration/apps/${appId}/readiness`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "App readiness is unavailable" });
  });

  it("never exposes resolver, membership, or verifier errors", async () => {
    for (const overrides of [
      { resolveCurrentBuild: async () => { throw new Error("/home/matrix/private/app"); } },
      { requireOrganizationMembership: async () => { throw new Error("clerk-secret"); } },
      { evaluator: { check: async () => { throw new Error("postgres password=secret"); } } },
      { evaluator: { check: async () => { throw "non-error-secret"; } } },
    ]) {
      const { routes } = setup(overrides);
      const response = await routes.request(`/api/collaboration/apps/${appId}/readiness/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
        body: JSON.stringify(checkBody),
      });
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).toBe(JSON.stringify({ error: "App readiness is unavailable", code: "unavailable" }));
    }
  });
});
