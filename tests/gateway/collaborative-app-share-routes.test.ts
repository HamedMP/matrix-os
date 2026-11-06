import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerCollaborativeAppReadinessRoutes } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-routes.js";
import { CollaborativeAppShareRepositoryError } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";

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
const share = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  owner: { actorId: "user_owner", displayName: "Owner" },
  build,
  readinessId: "60000000-0000-4000-8000-000000000001",
  state: "active" as const,
  shareRevision: "1",
  dataRevision: "0",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
};
const preflight = {
  organizationId: "org_matrix_team",
  expectedReadinessRevision: "2",
  expectedBuildId: build.buildId,
};
const create = {
  organizationId: "org_matrix_team",
  clientRequestId: "70000000-0000-4000-8000-000000000001",
  expectedResourceRevision: "0",
  expectedReadinessRevision: "2",
  readinessId: share.readinessId,
  buildId: build.buildId,
  confirmationToken: "token_payload.signature_value",
};
const stop = {
  clientRequestId: "70000000-0000-4000-8000-000000000002",
  expectedShareRevision: "1",
  expectedBindingRevision: "1",
};

function setup() {
  const routes = new Hono();
  routes.use("*", async (context, next) => {
    markAuthContextReady(context);
    const principal = context.req.header("x-test-principal");
    if (principal) setPlatformVerifiedPrincipal(context, principal);
    await next();
  });
  const shareService = {
    get: vi.fn(async () => share),
    preflight: vi.fn(async () => ({
      eligible: true,
      catalogId: build.catalogId,
      resourceRevision: "0",
      readinessId: share.readinessId,
      buildId: build.buildId,
      confirmationToken: "token_payload.signature_value",
    })),
    create: vi.fn(async () => share),
    stop: vi.fn(async () => ({ ...share, state: "stopped", shareRevision: "2" })),
  };
  const requireOrganizationMembership = vi.fn(async () => undefined);
  registerCollaborativeAppReadinessRoutes(routes, {
    ownerId: "user_owner",
    repository: { getCurrent: async () => null },
    evaluator: { check: async () => { throw new Error("unused"); } },
    resolveCurrentBuild: async () => null,
    requireOrganizationMembership,
    rateLimiter: { check: () => true },
    share: shareService,
  } as never);
  return { routes, shareService, requireOrganizationMembership };
}

const request = (routes: Hono, suffix: string, method = "GET", body?: unknown) => routes.request(
  `/api/collaboration/apps/${appId}/share${suffix}`,
  { method, headers: { "content-type": "application/json", "x-test-principal": "user_owner" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
);

describe("collaborative app share routes", () => {
  it("supports owner get/preflight/create/stop without project, role, grant, invite, or acceptance fields", async () => {
    const { routes, shareService, requireOrganizationMembership } = setup();
    expect(await (await request(routes, "")).json()).toEqual(share);
    expect((await request(routes, "/preflight", "POST", preflight)).status).toBe(200);
    expect((await request(routes, "", "POST", create)).status).toBe(201);
    expect((await request(routes, "", "DELETE", stop)).status).toBe(200);
    expect(requireOrganizationMembership).toHaveBeenCalledTimes(2);
    expect(shareService.preflight).toHaveBeenCalledWith("user_owner", appId, preflight);
    expect(shareService.create).toHaveBeenCalledWith("user_owner", appId, create);
    expect(shareService.stop).toHaveBeenCalledWith("user_owner", appId, stop);
    expect(JSON.stringify([
      ...shareService.preflight.mock.calls,
      ...shareService.create.mock.calls,
      ...shareService.stop.mock.calls,
    ])).not.toMatch(/role|grant|invitation|acceptance|projectId|recordFilter/);
  });

  it("strictly rejects app-specific permission vocabulary and oversized DELETE bodies", async () => {
    const { routes, shareService } = setup();
    for (const [suffix, method, body] of [
      ["/preflight", "POST", { ...preflight, role: "editor" }],
      ["", "POST", { ...create, grantId: "grant" }],
      ["", "DELETE", { ...stop, acceptance: true }],
    ] as const) {
      expect((await request(routes, suffix, method, body)).status).toBe(400);
    }
    expect((await request(routes, "", "DELETE", { padding: "x".repeat(100_000) })).status).toBe(413);
    expect(shareService.preflight).not.toHaveBeenCalled();
    expect(shareService.create).not.toHaveBeenCalled();
    expect(shareService.stop).not.toHaveBeenCalled();
  });

  it("rejects non-owners and maps internal failures to generic responses", async () => {
    const foreign = setup();
    expect((await foreign.routes.request(`/api/collaboration/apps/${appId}/share`, {
      headers: { "x-test-principal": "user_other" },
    })).status).toBe(403);
    const failed = setup();
    failed.shareService.get.mockRejectedValue(new Error("postgres password=private"));
    const response = await request(failed.routes, "");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/postgres|password|private/);
  });

  it("maps optimistic share repository conflicts to a retryable 409", async () => {
    const { routes, shareService } = setup();
    shareService.stop.mockRejectedValue(new CollaborativeAppShareRepositoryError("conflict"));

    const response = await request(routes, "", "DELETE", stop);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "App changed; refresh and try again", code: "conflict" });
  });
});
