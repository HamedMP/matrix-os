import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";
import { createDirectSessionRoutes } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority-error.js";
import { ResourceCatalogError } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { handle } from "../../packages/gateway/src/collaboration/route-support.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const proof = Buffer.from("{}").toString("base64url");
const context = { actorId: "member", ownerId: "owner", scopeId, membershipScopeId: scopeId,
  organizationId: "org", resourceKind: "project", resourceId: "project", role: "editor",
  authEpoch: 1, authorityRuntimeId: "runtime", authorityGeneration: 1, capability: "read" };

describe("home collaboration missing dependencies", () => {
  it.each([
    "/files", "/project", "/project/readiness", "/project/git", "/terminal", "/execution-policy", "/drive",
  ])("answers 503 unavailable for absent %s service", async (suffix) => {
    const app = createCollaborationRoutes({
      runtimeId: "runtime",
      verifier: { verifyAndAuthorize: async () => suffix === "/drive" ? { ...context, resourceKind: "folder" } : context },
    } as unknown as CollaborationRouteOptions);
    const response = await app.request(`/api/collaboration/scopes/${scopeId}${suffix}`, {
      headers: { "x-matrix-collaboration-proof": proof },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  });

  it("codes a missing direct owner-runtime dependency as unavailable", async () => {
    const app = createDirectSessionRoutes({ sessions: {} as Parameters<typeof createDirectSessionRoutes>[0]["sessions"] });
    const response = await app.request("/api/collaboration/owner-runtime/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  });

  it("keeps missing scope and missing resource distinct", async () => {
    const app = new Hono();
    app.get("/scope", (c) => handle(c, async () => { throw new CollaborationAuthorizationError("not_found", "private"); }));
    app.get("/resource", (c) => handle(c, async () => { throw new ResourceCatalogError("not_found"); }));
    const scope = await app.request("/scope");
    const resource = await app.request("/resource");
    expect(scope.status).toBe(404);
    expect(resource.status).toBe(404);
    expect(await scope.json()).toMatchObject({ code: "not_found" });
    expect(await resource.json()).toMatchObject({ code: "resource_missing" });
  });
});
